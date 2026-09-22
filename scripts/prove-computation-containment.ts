import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

import {
  PRODUCTION_COMPUTATION_CONTAINMENT,
  productionDockerIsolationArgs,
} from '../src/execution/containment.ts';

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const image=option('--image');
if (!image) throw new Error('--image is required');

const work=mkdtempSync(join(tmpdir(),'overcenter-containment-proof-'));
chmodSync(work,0o777);
const name=`overcenter-containment-proof-${process.pid}-${randomUUID()}`;

function docker(args:string[]):string {
  return execFileSync('docker',args,{encoding:'utf8'});
}

try {
  docker([
    'run',
    '-d',
    '--name',name,
    ...productionDockerIsolationArgs(),
    '-v',`${work}:/workspace`,
    image,
    '--concurrency',String(PRODUCTION_COMPUTATION_CONTAINMENT.executor_concurrency),
    '--task-uid',String(PRODUCTION_COMPUTATION_CONTAINMENT.task_uid),
    '--task-gid',String(PRODUCTION_COMPUTATION_CONTAINMENT.task_gid),
  ]);

  const deadline=Date.now()+10_000;
  while (!existsSync(join(work,'executor-killed')) && Date.now()<deadline) {
    const running=docker(['inspect','--format','{{.State.Running}}',name]).trim();
    if (running!=='true') break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!existsSync(join(work,'credential-proof')) || !existsSync(join(work,'executor-killed'))) {
    const state=docker(['inspect','--format','{{json .State}}',name]);
    const logs=docker(['logs',name]);
    throw new Error(`containment driver did not reach executor death proof: state=${state} logs=${logs}`);
  }

  assert.equal(
    readFileSync(join(work,'credential-proof'),'utf8').trim(),
    `executor=0 task=${PRODUCTION_COMPUTATION_CONTAINMENT.task_uid} groups=${PRODUCTION_COMPUTATION_CONTAINMENT.task_gid}`,
  );
  assert.ok(existsSync(join(work,'executor-killed')));

  const lines=docker(['top',name,'-eo','pid,ppid,cmd'])
    .trim().split('\n');
  if (lines.length<3) {
    throw new Error('expected worker driver plus hostile survivor after executor SIGKILL');
  }

  const pids=docker(['top',name,'-eo','pid'])
    .trim().split('\n').slice(1)
    .map(value=>Number.parseInt(value.trim(),10))
    .filter(Number.isSafeInteger);

  docker(['kill',name]);
  for (const pid of pids) {
    try {
      const output=execFileSync('ps',['-p',String(pid),'-o','pid='],{encoding:'utf8'}).trim();
      if (output) throw new Error(`container teardown left host process alive: ${pid}`);
    } catch (error:unknown) {
      const status=(error as {status?:number}).status;
      if (status!==1) throw error;
    }
  }
} finally {
  try {
    execFileSync('docker',['rm','-f',name],{stdio:'ignore'});
  } catch {}
  rmSync(work,{recursive:true,force:true});
}
