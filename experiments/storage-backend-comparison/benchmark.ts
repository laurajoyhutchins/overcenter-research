import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const PATHS={
  obligation:'obligation.json',
  claim:'claim.json',
  execution_authority:'execution-authority.json',
  effect_reservation:'effect-reservation.json',
  receipt:'receipt.json',
};
const KINDS=Object.keys(PATHS);
const json=value=>`${JSON.stringify(value,null,2)}\n`;
const canonical=value=>JSON.stringify(value);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const now=()=>performance.now();

function dirBytes(path) {
  let total=0;
  for (const entry of readdirSync(path,{withFileTypes:true})) {
    const full=join(path,entry.name);
    total+=entry.isDirectory()?dirBytes(full):statSync(full).size;
  }
  return total;
}

function factStream(n) {
  const out=[];
  for (let i=0;i<n;i+=1) {
    const cycle=Math.floor(i/5);
    const kind=KINDS[i%KINDS.length];
    const run=`run-${cycle.toString().padStart(8,'0')}`;
    const obligation=`obligation-${cycle.toString().padStart(8,'0')}`;
    let payload;

    if (kind==='obligation') {
      payload={
        schema:'overcenter-git-obligation-v3',
        kind:'defined',
        obligation:{
          id:obligation,
          dependencies:[],
          packet:{command:'npm test',input_sha256:sha256(`input:${cycle}`)},
          postcondition:{
            kind:'file-sha256',
            path:`out/${cycle}.json`,
            sha256:sha256(`out:${cycle}`),
          },
        },
      };
    } else if (kind==='claim') {
      payload={
        schema:'overcenter-git-claim-v3',
        run_id:run,
        obligation_id:obligation,
        claimed_revision:`revision-${cycle}`,
        obligation_key:sha256(`key:${cycle}`),
        execution_capability_sha256:sha256(`cap:${cycle}`),
      };
    } else if (kind==='execution_authority') {
      payload={
        schema:'overcenter-git-execution-authority-v1',
        run_id:run,
        obligation_id:obligation,
        generation:2,
        previous_authority_commit:`claim-${cycle}`,
        execution_capability_sha256:sha256(`cap2:${cycle}`),
      };
    } else if (kind==='effect_reservation') {
      payload={
        schema:'overcenter-git-effect-reservation-v1',
        run_id:run,
        obligation_id:obligation,
        execution_generation:2,
        execution_authority_commit:`exec-${cycle}`,
      };
    } else {
      payload={
        schema:'overcenter-git-receipt-v5',
        run_id:run,
        obligation_id:obligation,
        claimed_revision:`revision-${cycle}`,
        claim_commit:`claim-${cycle}`,
        execution_generation:2,
        execution_authority_commit:`exec-${cycle}`,
        kind:'observation',
        observed:{
          mutation_certainty:'present',
          actual_sha256:sha256(`out:${cycle}`),
        },
        diagnostic:{worker:'benchmark',attempt:cycle},
        settled_at:'2026-09-19T00:00:00.000Z',
      };
    }

    out.push({kind,payload});
  }
  return out;
}

class GitStore {
  constructor(repo,ref='refs/overcenter/state') {
    this.repo=repo;
    this.ref=ref;
  }

  git(args,{input,allowFailure=false}={}) {
    const env={
      ...process.env,
      GIT_AUTHOR_NAME:'Overcenter Kernel',
      GIT_AUTHOR_EMAIL:'overcenter@local',
      GIT_COMMITTER_NAME:'Overcenter Kernel',
      GIT_COMMITTER_EMAIL:'overcenter@local',
    };
    try {
      const stdout=execFileSync(
        'git',
        ['-C',this.repo,...args],
        {input,encoding:'utf8',env,stdio:['pipe','pipe','pipe']},
      );
      return {ok:true,stdout,stderr:''};
    } catch (error) {
      if (allowFailure) {
        return {
          ok:false,
          stdout:String(error.stdout??''),
          stderr:String(error.stderr??''),
        };
      }
      throw error;
    }
  }

  blob(content) {
    return this.git(['hash-object','-w','--stdin'],{input:content}).stdout.trim();
  }

  createCommit(parent,message,files={}) {
    const entries=Object.entries(files)
      .map(([name,value])=>[name,this.blob(json(value))])
      .sort(([a],[b])=>a.localeCompare(b));
    const treeInput=entries
      .map(([name,sha])=>`100644 blob ${sha}\t${name}\n`)
      .join('');
    const tree=this.git(['mktree'],{input:treeInput}).stdout.trim();
    const args=['commit-tree',tree];
    if (parent) args.push('-p',parent);
    return this.git(args,{input:`${message}\n`}).stdout.trim();
  }

  cas(next,expected) {
    return this.git(
      ['update-ref',this.ref,next,expected],
      {allowFailure:true},
    ).ok;
  }

  revisions(head) {
    return this.git(['rev-list','--reverse',head])
      .stdout.trim().split(/\n+/).filter(Boolean);
  }

  parent(commit) {
    const result=this.git(['rev-parse',`${commit}^`],{allowFailure:true});
    return result.ok?result.stdout.trim():null;
  }

  readJson(commit,path) {
    const result=this.git(['show',`${commit}:${path}`],{allowFailure:true});
    return result.ok?JSON.parse(result.stdout):null;
  }
}

function initializeGit(path) {
  mkdirSync(path,{recursive:true});
  execFileSync('git',['init','-q',path]);
  return new GitStore(path);
}

function gitWrite(repo,facts) {
  const store=initializeGit(repo);
  const initialize=store.createCommit(null,'overcenter: initialize');
  if (!store.cas(initialize,'0'.repeat(40))) throw new Error('INITIALIZE_LOST');
  let head=initialize;
  const started=now();
  for (let i=0;i<facts.length;i+=1) {
    const fact=facts[i];
    const next=store.createCommit(
      head,
      `overcenter: benchmark ${i}`,
      {[PATHS[fact.kind]]:fact.payload},
    );
    if (!store.cas(next,head)) throw new Error('CAS_LOST');
    head=next;
  }
  return {store,head,ms:now()-started};
}

function historyDigest(records) {
  const hash=createHash('sha256');
  for (const record of records) {
    hash.update(record.kind)
      .update('\0')
      .update(canonical(record.payload))
      .update('\n');
  }
  return hash.digest('hex');
}

function gitReplayCurrent(store,head) {
  const started=now();
  const records=[];
  for (const commit of store.revisions(head)) {
    store.parent(commit);
    for (const [kind,path] of Object.entries(PATHS)) {
      const payload=store.readJson(commit,path);
      if (payload!=null) records.push({kind,payload});
    }
  }
  return {ms:now()-started,records,digest:historyDigest(records)};
}

function parseCatFileBatch(output) {
  const records=[];
  let offset=0;
  while (offset<output.length) {
    const newline=output.indexOf('\n',offset);
    if (newline<0) break;
    const header=output.slice(offset,newline);
    offset=newline+1;
    if (header.endsWith(' missing')) {
      records.push(null);
      continue;
    }
    const size=Number(header.split(' ').at(-1));
    const content=output.slice(offset,offset+size);
    offset+=size+1;
    records.push(content);
  }
  return records;
}

function gitReplayBatched(store,head) {
  const started=now();
  const commits=store.revisions(head);
  const specs=[];
  const metadata=[];
  for (const commit of commits) {
    for (const [kind,path] of Object.entries(PATHS)) {
      specs.push(`${commit}:${path}`);
      metadata.push({kind});
    }
  }
  const raw=store.git(
    ['cat-file','--batch'],
    {input:`${specs.join('\n')}\n`},
  ).stdout;
  const parsed=parseCatFileBatch(raw);
  const records=[];
  for (let i=0;i<metadata.length;i+=1) {
    if (parsed[i]) {
      records.push({
        kind:metadata[i].kind,
        payload:JSON.parse(parsed[i]),
      });
    }
  }
  return {ms:now()-started,records,digest:historyDigest(records)};
}

class SqliteStore {
  constructor(path) {
    this.db=new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE authority (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        head TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      INSERT INTO authority VALUES (1,'${'0'.repeat(64)}',0);
      CREATE TABLE facts (
        seq INTEGER PRIMARY KEY,
        commit_id TEXT NOT NULL UNIQUE,
        parent TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    this.insert=this.db.prepare(
      'INSERT INTO facts(seq,commit_id,parent,kind,payload_json) VALUES(?,?,?,?,?)',
    );
    this.cas=this.db.prepare(
      'UPDATE authority SET head=?,seq=? WHERE singleton=1 AND head=? AND seq=?',
    );
    this.selectAll=this.db.prepare(
      'SELECT kind,payload_json FROM facts ORDER BY seq',
    );
  }

  append(expectedHead,expectedSeq,kind,payload) {
    const seq=expectedSeq+1;
    const payloadJson=canonical(payload);
    const commit=sha256(
      `${expectedHead}\0${seq}\0${kind}\0${payloadJson}`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insert.run(seq,commit,expectedHead,kind,payloadJson);
      const result=this.cas.run(
        commit,seq,expectedHead,expectedSeq,
      );
      if (result.changes!==1) throw new Error('CAS_LOST');
      this.db.exec('COMMIT');
      return {head:commit,seq};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replay() {
    return this.selectAll.all().map(row=>({
      kind:row.kind,
      payload:JSON.parse(row.payload_json),
    }));
  }

  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}

function sqliteWrite(path,facts) {
  const store=new SqliteStore(path);
  let head='0'.repeat(64);
  let seq=0;
  const started=now();
  for (const fact of facts) {
    const next=store.append(head,seq,fact.kind,fact.payload);
    head=next.head;
    seq=next.seq;
  }
  return {store,head,seq,ms:now()-started};
}

function sqliteReplay(store) {
  const started=now();
  const records=store.replay();
  return {ms:now()-started,records,digest:historyDigest(records)};
}

function runOne(n) {
  const root=mkdtempSync(join(tmpdir(),`oc-storage-${n}-`));
  const facts=factStream(n);
  const sourceDigest=historyDigest(facts);
  const gitPath=join(root,'git');
  const sqlitePath=join(root,'facts.sqlite');

  const gitWriteResult=gitWrite(gitPath,facts);
  const gitLoose=dirBytes(join(gitPath,'.git'));
  const gitCurrent=gitReplayCurrent(
    gitWriteResult.store,
    gitWriteResult.head,
  );
  const gitBatched=gitReplayBatched(
    gitWriteResult.store,
    gitWriteResult.head,
  );
  execFileSync('git',['-C',gitPath,'gc','--prune=now','-q']);
  const gitPacked=dirBytes(join(gitPath,'.git'));

  const sqliteWriteResult=sqliteWrite(sqlitePath,facts);
  const sqliteReplayResult=sqliteReplay(sqliteWriteResult.store);
  sqliteWriteResult.store.close();
  const sqliteBytes=statSync(sqlitePath).size;

  const ok=[
    gitCurrent.digest,
    gitBatched.digest,
    sqliteReplayResult.digest,
  ].every(digest=>digest===sourceDigest)
    && gitCurrent.records.length===n
    && gitBatched.records.length===n
    && sqliteReplayResult.records.length===n;

  const result={
    n,
    ok,
    source_digest:sourceDigest,
    git:{
      write_ms:gitWriteResult.ms,
      write_facts_per_s:n/(gitWriteResult.ms/1000),
      replay_current_ms:gitCurrent.ms,
      replay_batched_ms:gitBatched.ms,
      loose_bytes:gitLoose,
      packed_bytes:gitPacked,
    },
    sqlite:{
      write_ms:sqliteWriteResult.ms,
      write_facts_per_s:n/(sqliteWriteResult.ms/1000),
      replay_ms:sqliteReplayResult.ms,
      bytes:sqliteBytes,
    },
    ratios:{
      write_speedup_sqlite_over_git:
        gitWriteResult.ms/sqliteWriteResult.ms,
      replay_speedup_sqlite_over_git_current:
        gitCurrent.ms/sqliteReplayResult.ms,
      replay_speedup_sqlite_over_git_batched:
        gitBatched.ms/sqliteReplayResult.ms,
      packed_git_bytes_over_sqlite:
        gitPacked/sqliteBytes,
    },
  };

  rmSync(root,{recursive:true,force:true});
  return result;
}

const sizes=process.argv.slice(2).map(Number).filter(Number.isFinite);
if (sizes.length===0) sizes.push(10,25,50,100,200);

const results=[];
for (const n of sizes) {
  const result=runOne(n);
  results.push(result);
  console.log(JSON.stringify(result));
}

console.log(JSON.stringify({
  node:process.version,
  git:execFileSync('git',['--version'],{encoding:'utf8'}).trim(),
  platform:`${process.platform}/${process.arch}`,
  results,
},null,2));
