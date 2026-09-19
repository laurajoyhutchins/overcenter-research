import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ZERO_GIT='0'.repeat(40);
const ZERO_SQLITE='0'.repeat(64);
const hash=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>Atomics.wait(
  new Int32Array(new SharedArrayBuffer(4)),
  0,
  0,
  ms,
);
const gitEnv={
  ...process.env,
  GIT_AUTHOR_NAME:'Overcenter Kernel',
  GIT_AUTHOR_EMAIL:'overcenter@local',
  GIT_COMMITTER_NAME:'Overcenter Kernel',
  GIT_COMMITTER_EMAIL:'overcenter@local',
};

function git(path,args,{input,allowFailure=false}={}) {
  const result=spawnSync(
    'git',
    ['-C',path,...args],
    {
      input,
      encoding:'utf8',
      env:gitEnv,
      stdio:['pipe','pipe','pipe'],
    },
  );
  if (result.status!==0 && !allowFailure) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return {
    ok:result.status===0,
    stdout:result.stdout??'',
    stderr:result.stderr??'',
  };
}

function initializeGit(path) {
  mkdirSync(path,{recursive:true});
  execFileSync('git',['init','-q',path]);
  const tree=git(path,['mktree'],{input:''}).stdout.trim();
  const base=git(path,['commit-tree',tree],{input:'base\n'}).stdout.trim();
  assert.equal(
    git(
      path,
      ['update-ref','refs/overcenter/state',base,ZERO_GIT],
    ).ok,
    true,
  );
  return base;
}

function gitCasCheck(root) {
  const path=join(root,'git-cas');
  const base=initializeGit(path);
  const tree=git(path,['mktree'],{input:''}).stdout.trim();
  const first=git(
    path,
    ['commit-tree',tree,'-p',base],
    {input:'first\n'},
  ).stdout.trim();
  const second=git(
    path,
    ['commit-tree',tree,'-p',base],
    {input:'second\n'},
  ).stdout.trim();
  const firstWon=git(
    path,
    ['update-ref','refs/overcenter/state',first,base],
    {allowFailure:true},
  ).ok;
  const secondWon=git(
    path,
    ['update-ref','refs/overcenter/state',second,base],
    {allowFailure:true},
  ).ok;
  assert.equal(Number(firstWon)+Number(secondWon),1);
  return {first:firstWon,second:secondWon,winners:1};
}

function sqliteCasCheck(root) {
  const path=join(root,'cas.sqlite');
  const db=new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE authority(
      singleton INTEGER PRIMARY KEY,
      head TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    INSERT INTO authority VALUES(1,'${ZERO_SQLITE}',0);
    CREATE TABLE facts(
      seq INTEGER PRIMARY KEY,
      commit_id TEXT UNIQUE,
      parent TEXT,
      payload TEXT
    );
  `);
  const insert=db.prepare(
    'INSERT INTO facts VALUES(?,?,?,?)',
  );
  const cas=db.prepare(
    'UPDATE authority SET head=?,seq=? WHERE singleton=1 AND head=? AND seq=?',
  );

  const attempt=label=>{
    const next=hash(label);
    try {
      db.exec('BEGIN IMMEDIATE');
      insert.run(1,next,ZERO_SQLITE,label);
      const result=cas.run(
        next,
        1,
        ZERO_SQLITE,
        0,
      );
      if (result.changes!==1) throw new Error('CAS_LOST');
      db.exec('COMMIT');
      return true;
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {}
      return false;
    }
  };

  const first=attempt('first');
  const second=attempt('second');
  const rows=Number(
    db.prepare('SELECT COUNT(*) AS n FROM facts').get().n,
  );
  db.close();

  assert.equal(Number(first)+Number(second),1);
  assert.equal(rows,1);
  return {first,second,winners:1,rows};
}

if (process.argv[2]==='git-child') {
  const path=process.argv[3];
  let head=initializeGit(path);

  for (let i=0;i<1000;i+=1) {
    const payload=JSON.stringify({
      i,
      data:hash(`payload:${i}`),
    });
    const blob=git(
      path,
      ['hash-object','-w','--stdin'],
      {input:payload},
    ).stdout.trim();
    const tree=git(
      path,
      ['mktree'],
      {input:`100644 blob ${blob}\tfact.json\n`},
    ).stdout.trim();
    const next=git(
      path,
      ['commit-tree',tree,'-p',head],
      {input:`fact ${i}\n`},
    ).stdout.trim();

    assert.equal(
      git(
        path,
        ['update-ref','refs/overcenter/state',next,head],
      ).ok,
      true,
    );
    head=next;
    console.log(i+1);
    sleep(5);
  }
  process.exit(0);
}

if (process.argv[2]==='sqlite-child') {
  const path=process.argv[3];
  const db=new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE authority(
      singleton INTEGER PRIMARY KEY,
      head TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    INSERT INTO authority VALUES(1,'${ZERO_SQLITE}',0);
    CREATE TABLE facts(
      seq INTEGER PRIMARY KEY,
      commit_id TEXT NOT NULL UNIQUE,
      parent TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const insert=db.prepare(
    'INSERT INTO facts VALUES(?,?,?,?)',
  );
  const cas=db.prepare(
    'UPDATE authority SET head=?,seq=? WHERE singleton=1 AND head=? AND seq=?',
  );

  let head=ZERO_SQLITE;
  let seq=0;
  for (let i=0;i<1000;i+=1) {
    const nextSeq=seq+1;
    const payload=JSON.stringify({
      i,
      data:hash(`payload:${i}`),
    });
    const next=hash(
      `${head}\0${nextSeq}\0${payload}`,
    );

    db.exec('BEGIN IMMEDIATE');
    insert.run(nextSeq,next,head,payload);
    assert.equal(
      cas.run(next,nextSeq,head,seq).changes,
      1,
    );
    db.exec('COMMIT');

    head=next;
    seq=nextSeq;
    console.log(seq);
    sleep(5);
  }
  process.exit(0);
}

async function killAfter(childMode,path,target=20) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(
      process.execPath,
      [import.meta.filename,childMode,path],
      {stdio:['ignore','pipe','inherit']},
    );

    let buffer='';
    let seen=0;
    let killed=false;

    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      const lines=buffer.split('\n');
      buffer=lines.pop()??'';
      for (const line of lines) {
        if (line.trim()) seen=Number(line);
        if (!killed && seen>=target) {
          killed=true;
          child.kill('SIGKILL');
        }
      }
    });

    child.on('error',reject);
    child.on(
      'close',
      (code,signal)=>resolve({seen,code,signal}),
    );
  });
}

async function crashChecks(root) {
  const gitPath=join(root,'git-crash');
  const gitKill=await killAfter('git-child',gitPath);
  const gitHead=git(
    gitPath,
    ['rev-parse','refs/overcenter/state'],
  ).stdout.trim();
  const reachableFacts=Number(
    git(
      gitPath,
      ['rev-list','--count',gitHead],
    ).stdout.trim(),
  )-1;
  const fsck=git(
    gitPath,
    ['fsck','--full','--no-reflogs'],
    {allowFailure:true},
  );

  assert.equal(gitKill.signal,'SIGKILL');
  assert.equal(reachableFacts,gitKill.seen);
  assert.equal(fsck.ok,true);

  const sqlitePath=join(root,'crash.sqlite');
  const sqliteKill=await killAfter(
    'sqlite-child',
    sqlitePath,
  );
  const db=new DatabaseSync(sqlitePath);
  const integrity=db
    .prepare('PRAGMA integrity_check')
    .get().integrity_check;
  const authority=db
    .prepare('SELECT head,seq FROM authority')
    .get();
  const rows=Number(
    db.prepare('SELECT COUNT(*) AS n FROM facts').get().n,
  );
  const brokenParentLinks=Number(
    db.prepare(`
      SELECT COUNT(*) AS n
      FROM facts f
      LEFT JOIN facts p
        ON p.commit_id=f.parent
      WHERE f.seq>1
        AND p.commit_id IS NULL
    `).get().n,
  );
  db.close();

  assert.equal(sqliteKill.signal,'SIGKILL');
  assert.equal(integrity,'ok');
  assert.equal(Number(authority.seq),sqliteKill.seen);
  assert.equal(rows,sqliteKill.seen);
  assert.equal(brokenParentLinks,0);

  return {
    git:{
      kill:gitKill,
      reachable_facts:reachableFacts,
      head:gitHead,
      fsck_ok:true,
    },
    sqlite:{
      kill:sqliteKill,
      integrity,
      authority_seq:Number(authority.seq),
      rows,
      broken_parent_links:brokenParentLinks,
      head:authority.head,
    },
  };
}

const root=mkdtempSync(
  join(tmpdir(),'overcenter-storage-safety-'),
);
try {
  const result={
    cas:{
      git:gitCasCheck(root),
      sqlite:sqliteCasCheck(root),
    },
    crash:await crashChecks(root),
  };
  console.log(JSON.stringify(result,null,2));
} finally {
  rmSync(root,{recursive:true,force:true});
}
