import {execFileSync} from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,sep} from 'node:path';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

function git(
  args:string[],
  {
    input=undefined,
    env=process.env,
  }:{input?:Buffer|string;env?:Record<string,string|undefined>}={},
):string {
  return execFileSync('git',args,{
    cwd:process.cwd(),
    input,
    env,
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  }).trim();
}

function files(root:string):string[] {
  const out:string[]=[];
  const visit=(dir:string):void=>{
    for (const name of readdirSync(dir).sort()) {
      const full=join(dir,name);
      const stat=statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) out.push(relative(root,full).split(sep).join('/'));
      else throw new Error('RESPONSE_NONREGULAR_FILE');
    }
  };
  visit(root);
  return out;
}

const responseDir=option('--response-dir');
if (!responseDir) throw new Error('usage: github-agent-publish-response.ts --response-dir <dir>');

const requestSha=required('REQUEST_ID').toLowerCase();
const sourceSha=required('SOURCE_SHA').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(requestSha)) throw new Error('REQUEST_ID_INVALID');
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID');

const remote=process.env.OVERCENTER_RESPONSE_REMOTE??'origin';
const responseRef=`refs/heads/overcenter/response/${requestSha}`;
const expectedFiles=files(responseDir);
if (expectedFiles.length===0) throw new Error('RESPONSE_EMPTY');

const existing=git(['ls-remote',remote,responseRef]);
if (existing) {
  const existingSha=existing.split(/\s+/)[0];
  const cacheRef=`refs/overcenter/response-cache/${requestSha}`;
  git(['fetch','--no-tags',remote,`+${responseRef}:${cacheRef}`]);
  const actual=git(['ls-tree','-r','--name-only',cacheRef])
    .split(/\n+/)
    .filter(Boolean);
  const expected=expectedFiles.map(path=>`.overcenter/${path}`);
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    throw new Error('RESPONSE_REPLAY_TREE_MISMATCH');
  }
  for (const path of expectedFiles) {
    const expectedBytes=readFileSync(join(responseDir,path));
    const actualBytes=execFileSync(
      'git',
      ['show',`${cacheRef}:.overcenter/${path}`],
      {cwd:process.cwd()},
    );
    if (!expectedBytes.equals(actualBytes)) {
      throw new Error(`RESPONSE_REPLAY_BYTES_MISMATCH:${path}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    response_ref:responseRef,
    response_commit:existingSha,
    replay:true,
  })}\n`);
  process.exit(0);
}

const scratch=mkdtempSync(join(tmpdir(),'overcenter-response-'));
try {
  const index=join(scratch,'index');
  const env={...process.env,GIT_INDEX_FILE:index};
  git(['read-tree','--empty'],{env});
  for (const path of expectedFiles) {
    const bytes=readFileSync(join(responseDir,path));
    const blob=git(['hash-object','-w','--stdin'],{input:bytes});
    git([
      'update-index',
      '--add',
      '--cacheinfo',
      '100644',
      blob,
      `.overcenter/${path}`,
    ],{env});
  }
  const tree=git(['write-tree'],{env});
  const date=git(['show','-s','--format=%cI',requestSha]);
  const commitEnv={
    ...process.env,
    GIT_AUTHOR_NAME:'Overcenter Adapter',
    GIT_AUTHOR_EMAIL:'overcenter@local',
    GIT_COMMITTER_NAME:'Overcenter Adapter',
    GIT_COMMITTER_EMAIL:'overcenter@local',
    GIT_AUTHOR_DATE:date,
    GIT_COMMITTER_DATE:date,
  };
  const commit=git(
    ['commit-tree',tree,'-p',sourceSha],
    {input:`overcenter: response ${requestSha}\n`,env:commitEnv},
  );
  const lease=`--force-with-lease=${responseRef}:`;
  try {
    git(['push','--porcelain',lease,remote,`${commit}:${responseRef}`]);
  } catch {
    const winner=git(['ls-remote',remote,responseRef]);
    if (!winner) throw new Error('RESPONSE_PUBLISH_LOST_WITHOUT_WINNER');
    throw new Error('RESPONSE_PUBLISH_LOST');
  }
  process.stdout.write(`${JSON.stringify({
    response_ref:responseRef,
    response_commit:commit,
    replay:false,
  })}\n`);
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
