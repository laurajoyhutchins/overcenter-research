import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  PROCESS_COMPUTATION_PACKET_SCHEMA,
  PROCESS_SPEC_SCHEMA,
  computationExecution,
  type ProcessSpecV1,
} from '../src/computation-execution.ts';
import { runReadyComputation } from '../src/computation-loop.ts';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import { GoExecutorClient } from '../src/go-executor-client.ts';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const executorDir=join(repoRoot,'executor');
const fixture=join(repoRoot,'test/fixtures/computation-child.mjs');
const scratch=mkdtempSync(join(tmpdir(),'overcenter-computation-cutover-'));
const binary=join(scratch,'overcenter-executor');
execFileSync('go',['build','-o',binary,'./cmd/overcenter-executor'],{
  cwd:executorDir,
  stdio:'inherit',
});
after(()=>rmSync(scratch,{recursive:true,force:true}));

let sequence=0;

function makeRepo():{root:string;repo:string;workspace:string;kernel:GitOvercenterKernel} {
  const root=join(scratch,'case-'+sequence++);
  const repo=join(root,'repo');
  const workspace=join(root,'workspace');
  mkdirSync(workspace,{recursive:true});
  execFileSync('git',['init',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'config','user.email','test@example.com']);
  execFileSync('git',['-C',repo,'config','user.name','Test']);
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,workspace,kernel};
}

interface Harness {
  client:GoExecutorClient;
  child:ChildProcessWithoutNullStreams;
  socketPath:string;
  close:()=>Promise<void>;
}

async function startExecutor(workspace:string):Promise<Harness> {
  const socketPath=join(workspace,'executor.sock');
  const child=spawn(binary,[
    '--socket='+socketPath,
    '--workspace-root='+workspace,
    '--concurrency=1',
    '--unsafe-test-same-uid',
  ],{stdio:['pipe','pipe','pipe'],env:{}});
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});

  const deadline=Date.now()+3000;
  while (Date.now()<deadline && !existsSync(socketPath)) {
    if (child.exitCode!==null) throw new Error('executor exited: '+stderr);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if (!existsSync(socketPath)) throw new Error('executor socket did not appear: '+stderr);

  const client=new GoExecutorClient({socketPath,maxConcurrency:1});
  return {
    client,
    child,
    socketPath,
    close:async()=>{
      await client.close();
      const code=await new Promise<number|null>((resolve,reject)=>{
        if (child.exitCode!==null) return resolve(child.exitCode);
        child.once('error',reject);
        child.once('close',resolve);
      });
      assert.equal(code,0,stderr);
    },
  };
}

function processSpec(
  mode:string,
  arg:string,
  fourth:string,
  timeoutMs=3000,
):ProcessSpecV1 {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:process.execPath,
    argv:[fixture,mode,arg,fourth],
    cwd:'.',
    env:{},
    timeout_ms:timeoutMs,
    stdout_max_bytes:4096,
    stderr_max_bytes:4096,
  };
}

function defineComputation(
  kernel:GitOvercenterKernel,
  id:string,
  spec:ProcessSpecV1,
  path:string,
  content:string,
):void {
  kernel.define({
    id,
    packet:{
      schema:PROCESS_COMPUTATION_PACKET_SCHEMA,
      process:spec,
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path,
      content,
    },
  });
}

function factNames(repo:string):string[] {
  const commits=execFileSync(
    'git',
    ['-C',repo,'rev-list','--reverse','refs/overcenter/state'],
    {encoding:'utf8'},
  ).trim().split(/\n+/).filter(Boolean);
  return commits.flatMap(commit=>execFileSync(
    'git',
    ['-C',repo,'ls-tree','--name-only',commit],
    {encoding:'utf8'},
  ).trim().split(/\n+/).filter(Boolean));
}

test('Go computation writes durable intent and attempt, then observation settles DONE',async()=>{
  const {repo,workspace,kernel}=makeRepo();
  const output=join(workspace,'result.txt');
  defineComputation(
    kernel,
    'build',
    processSpec('write-file','result.txt','verified'),
    output,
    'verified',
  );
  const harness=await startExecutor(workspace);
  try {
    const result=await runReadyComputation(kernel,harness.client);
    assert.equal(result.state,'DONE');
    assert.equal(result.evidence?.outcome,'completed');
    assert.equal(kernel.inspect()[0].status,'DONE');

    const attempts=kernel.computationAttempts();
    assert.equal(attempts.length,1);
    assert.equal(attempts[0].evidence.outcome,'completed');

    const reconstructed=new GitOvercenterKernel(repo).computationAttempts();
    assert.deepEqual(reconstructed,attempts);

    const names=factNames(repo);
    assert.equal(names.filter(name=>name==='computation-intent.json').length,1);
    assert.equal(names.filter(name=>name==='computation-attempt.json').length,1);
    assert.equal(names.includes('effect-reservation.json'),false);
  } finally {
    await harness.close();
  }
});

test('process exit zero cannot settle a mismatching postcondition',async()=>{
  const {repo,workspace,kernel}=makeRepo();
  const output=join(workspace,'wrong.txt');
  defineComputation(
    kernel,
    'wrong-output',
    processSpec('write-file','wrong.txt','wrong'),
    output,
    'right',
  );
  const harness=await startExecutor(workspace);
  try {
    const result=await runReadyComputation(kernel,harness.client);
    assert.equal(result.evidence?.outcome,'completed');
    assert.equal(result.state,'RECOVERY_REQUIRED');
    assert.equal(result.receipt?.verified,false);
    assert.equal(kernel.inspect()[0].status,'RECOVERY_REQUIRED');
    assert.equal(factNames(repo).includes('effect-reservation.json'),false);
  } finally {
    await harness.close();
  }
});

test('failed pure computation records evidence and authoritative absence returns READY',async()=>{
  const {repo,workspace,kernel}=makeRepo();
  const output=join(workspace,'missing.txt');
  defineComputation(
    kernel,
    'failed-build',
    processSpec('fail','',''),
    output,
    'expected',
  );
  const harness=await startExecutor(workspace);
  try {
    const result=await runReadyComputation(kernel,harness.client);
    assert.equal(result.evidence?.outcome,'failed');
    assert.equal(result.evidence?.exit_code,17);
    assert.equal(result.state,'READY');
    assert.equal(kernel.inspect()[0].status,'READY');
    assert.equal(kernel.computationAttempts().length,1);
    assert.equal(factNames(repo).includes('effect-reservation.json'),false);
  } finally {
    await harness.close();
  }
});

test('computation worker skips unrelated effectful work in the same ready frontier',async()=>{
  const {repo,workspace,kernel}=makeRepo();
  kernel.define({
    id:'a-effect',
    packet:{kind:'provider-effect'},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:join(workspace,'effect.txt'),
      content:'effect',
    },
  });
  defineComputation(
    kernel,
    'z-compute',
    processSpec('write-file','compute.txt','done'),
    join(workspace,'compute.txt'),
    'done',
  );

  const harness=await startExecutor(workspace);
  try {
    const result=await runReadyComputation(kernel,harness.client);
    assert.equal(result.state,'DONE');
    assert.equal(result.work,'z-compute');
    const statuses=new Map(kernel.inspect().map(work=>[work.id,work.status]));
    assert.equal(statuses.get('z-compute'),'DONE');
    assert.equal(statuses.get('a-effect'),'READY');
    assert.equal(factNames(repo).includes('effect-reservation.json'),false);
  } finally {
    await harness.close();
  }
});

test('late generation-one evidence cannot become durable after authority advances',async()=>{
  const {workspace,kernel}=makeRepo();
  const spec=processSpec('write-file','late.txt','late');
  defineComputation(
    kernel,
    'late-evidence',
    spec,
    join(workspace,'late.txt'),
    'late',
  );

  const work=kernel.deriveReadyWork();
  assert.ok(work);
  const permit=kernel.claim(work.id,work.revision);
  const execution=computationExecution(permit,spec);
  kernel.prepareComputation(permit,execution);

  const harness=await startExecutor(workspace);
  try {
    const evidence=await harness.client.execute(execution);
    assert.equal(evidence.outcome,'completed');

    const fresh=kernel.acquireExecution(permit.id);
    assert.equal(fresh.execution_generation,2);
    assert.throws(
      ()=>kernel.recordComputationAttempt(permit,execution,evidence),
      /STALE_EXECUTION_GENERATION/,
    );
    assert.equal(kernel.computationAttempts().length,0);
    assert.equal(kernel.computationIntents(permit.id).length,1);
  } finally {
    await harness.close();
  }
});

test('executor death leaves durable intent but no fabricated attempt and requires recovery',async()=>{
  const {repo,workspace,kernel}=makeRepo();
  const pidFile=join(workspace,'hang.pid');
  const output=join(workspace,'never.txt');
  defineComputation(
    kernel,
    'interrupted',
    processSpec('hang','',pidFile,30_000),
    output,
    'never',
  );
  const harness=await startExecutor(workspace);
  const pending=runReadyComputation(kernel,harness.client);

  const deadline=Date.now()+3000;
  while (Date.now()<deadline && !existsSync(pidFile)) {
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(existsSync(pidFile),'computation never started');
  const taskPid=Number.parseInt(readFileSync(pidFile,'utf8').trim().split(':')[1]!,10);
  assert.ok(Number.isSafeInteger(taskPid));

  harness.child.kill('SIGKILL');
  const result=await pending;
  assert.equal(result.state,'RECOVERY_REQUIRED');
  assert.equal(result.attempt_commit,undefined);
  assert.equal(kernel.computationAttempts().length,0);
  assert.equal(kernel.inspect()[0].status,'RECOVERY_REQUIRED');

  const names=factNames(repo);
  assert.equal(names.filter(name=>name==='computation-intent.json').length,1);
  assert.equal(names.includes('computation-attempt.json'),false);
  assert.equal(names.includes('effect-reservation.json'),false);

  const deathDeadline=Date.now()+3000;
  while (Date.now()<deathDeadline) {
    try {
      process.kill(taskPid,0);
      await new Promise(resolve=>setTimeout(resolve,20));
    } catch {
      return;
    }
  }
  assert.fail('direct computation process survived executor death');
});
