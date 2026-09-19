import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  PROCESS_SPEC_SCHEMA,
  assertComputationEvidenceFor,
  computationExecution,
  executionIdentityKey,
  validateComputationExecution,
  validateProcessSpec,
  type ProcessSpecV1,
} from '../src/computation-execution.ts';
import {
  REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
  TEST_COMPUTATION_PACKET_SCHEMA,
  resumeTestComputation,
  runReadyTestComputation,
} from '../src/computation-runner.ts';
import { GitOvercenterKernel, runGitCoreLoop } from '../src/git-kernel.ts';
import { GoExecutorClient } from '../src/go-executor-client.ts';
import type { ExecutionPermit } from '../src/model.ts';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const executorDir=join(repoRoot,'executor');
const fixture=join(repoRoot,'test/fixtures/computation-child.mjs');
const scratch=mkdtempSync(join(tmpdir(),'overcenter-production-executor-'));
const workspace=join(scratch,'workspace');
const binary=join(scratch,'overcenter-executor');
mkdirSync(workspace,{recursive:true});
execFileSync('go',['build','-o',binary,'./cmd/overcenter-executor'],{
  cwd:executorDir,
  stdio:'inherit',
});
after(()=>rmSync(scratch,{recursive:true,force:true}));

const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const attestedExecutionContext='sha256:'+sha256('executor-test-context');
const attestedContainmentId='executor-test-containment';
const attestationArgs=[
  `--execution-context-sha256=${attestedExecutionContext}`,
  `--containment-id=${attestedContainmentId}`,
];
const testExecutionContext='sha256:'+sha256('test-execution-context');

let executorSequence=0;
let kernelSequence=0;

interface ExecutorHarness {
  client:GoExecutorClient;
  child:ChildProcessWithoutNullStreams;
  socketPath:string;
  close:()=>Promise<void>;
  abort:()=>Promise<void>;
}

async function startExecutor(
  maxConcurrency:number,
  workspaceRoot=workspace,
  executionContextSha256=testExecutionContext,
):Promise<ExecutorHarness> {
  const socketPath=join(scratch,`executor-${executorSequence++}.sock`);
  rmSync(socketPath,{force:true});
  const child=spawn(
    binary,
    [
      '--stdio',
      `--workspace-root=${workspaceRoot}`,
      `--concurrency=${maxConcurrency}`,
      '--unsafe-test-same-uid',
    ],
    {stdio:['pipe','pipe','pipe'],env:{}},
  );
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});

  if (child.pid===undefined) throw new Error('executor pid unavailable');
  const containmentId=`process:${child.pid}`;
  const relaySockets=new Set<Socket>();
  const relay=createServer(socket=>{
    relaySockets.add(socket);
    socket.on('close',()=>relaySockets.delete(socket));
    socket.on('error',()=>{});
    socket.write(JSON.stringify({
      schema:'overcenter-executor-hello-v1',
      execution_context_sha256:executionContextSha256,
      containment_id:containmentId,
    })+'\n');
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  await new Promise<void>((resolve,reject)=>{
    relay.once('error',reject);
    relay.listen(socketPath,()=>resolve());
  });

  const waitForChild=async():Promise<number|null>=>{
    if (child.exitCode!==null || child.signalCode!==null) {
      return child.exitCode;
    }
    return await new Promise<number|null>((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',resolve);
    });
  };
  const closeRelay=async():Promise<void>=>{
    for (const socket of relaySockets) socket.destroy();
    if (!relay.listening) return;
    await new Promise<void>((resolve,reject)=>{
      relay.close(error=>error?reject(error):resolve());
    });
  };

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency,
    executionContextSha256,
    containmentId,
  });
  return {
    client,
    child,
    socketPath,
    close:async()=>{
      await client.close();
      await closeRelay();
      const code=await waitForChild();
      assert.equal(code,0,stderr);
    },
    abort:async()=>{
      if (child.exitCode===null && child.signalCode===null) {
        child.kill('SIGKILL');
      }
      await closeRelay();
      await waitForChild();
    },
  };
}

function kernelFixture():{
  root:string;
  repo:string;
  kernel:GitOvercenterKernel;
} {
  const root=join(scratch,`kernel-${kernelSequence++}`);
  const repo=join(root,'state.git');
  mkdirSync(root,{recursive:true});
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel};
}

function assertNoEffectReservations(repo:string):void {
  const commits=execFileSync(
    'git',
    ['-C',repo,'rev-list','refs/overcenter/state'],
    {encoding:'utf8'},
  ).trim().split(/\n+/).filter(Boolean);
  for (const commit of commits) {
    assert.throws(
      ()=>execFileSync(
        'git',
        ['-C',repo,'cat-file','-e',`${commit}:effect-reservation.json`],
        {stdio:'ignore'},
      ),
    );
  }
}

function permit(index:number,generation=1,authority=`authority-${index}-g${generation}`):ExecutionPermit {
  const capability=`capability-${index}-g${generation}`;
  return {
    id:`run-${index}`,
    obligation_id:`obligation-${index}`,
    claimed_revision:`revision-${index}`,
    claim_commit:`claim-${index}`,
    obligation_key:`key-${index}`,
    execution_generation:generation,
    execution_authority_commit:authority,
    execution_capability_sha256:sha256(capability),
    execution_capability:capability,
  };
}

function spec(
  mode:string,
  arg='',
  {
    env={},
    stdoutMax=4096,
    stderrMax=4096,
    pidFile='',
    timeoutMs=5000,
  }:{
    env?:Record<string,string>;
    stdoutMax?:number;
    stderrMax?:number;
    pidFile?:string;
    timeoutMs?:number;
  }={},
):ProcessSpecV1 {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:process.execPath,
    argv:[fixture,mode,arg,pidFile],
    cwd:'.',
    env,
    timeout_ms:timeoutMs,
    stdout_max_bytes:stdoutMax,
    stderr_max_bytes:stderrMax,
  };
}

function alive(pid:number):boolean {
  try {
    process.kill(pid,0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code!=='ESRCH';
  }
}

async function waitForPidFile(path:string,count:number):Promise<number[]> {
  const deadline=Date.now()+3000;
  while (Date.now()<deadline) {
    if (existsSync(path)) {
      const records=readFileSync(path,'utf8').trim().split('\n').filter(Boolean);
      if (records.length>=count) {
        return records.slice(0,count).map(record=>Number.parseInt(record.split(':')[1]!,10));
      }
    }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error(`timed out waiting for pid file ${path}`);
}

async function assertDead(pids:number[]):Promise<void> {
  const deadline=Date.now()+3000;
  while (Date.now()<deadline && pids.some(alive)) {
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.deepEqual(pids.filter(alive),[]);
}

test('TypeScript and Go accept the same process-spec conformance corpus',()=>{
  const corpus=JSON.parse(readFileSync(
    join(repoRoot,'contracts/computation-execution-v1/process-spec-conformance.json'),
    'utf8',
  )) as {
    cases:Array<{name:string;valid:boolean;spec:unknown}>;
  };
  for (const testCase of corpus.cases) {
    let accepted=true;
    try {
      validateProcessSpec(testCase.spec);
    } catch {
      accepted=false;
    }
    assert.equal(accepted,testCase.valid,testCase.name);
  }
});

test('executor requires explicit concurrency',async()=>{
  const child=spawn(
    binary,
    ['--stdio',`--workspace-root=${workspace}`,'--unsafe-test-same-uid'],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const code=await new Promise<number|null>((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',resolve);
  });
  assert.notEqual(code,0);
  assert.match(stderr,/max concurrency must be positive/);
});

test('production socket mode fails closed without a distinct task credential',async()=>{
  const missingSocket=join(scratch,'missing-credential.sock');
  const missing=spawn(
    binary,
    [
      `--socket=${missingSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let missingStderr='';
  missing.stderr.setEncoding('utf8');
  missing.stderr.on('data',chunk=>{missingStderr+=String(chunk);});
  const missingCode=await new Promise<number|null>((resolve,reject)=>{
    missing.once('error',reject);
    missing.once('close',resolve);
  });
  assert.notEqual(missingCode,0);
  assert.match(missingStderr,/requires --task-uid and --task-gid/);

  const uid=process.getuid?.();
  const gid=process.getgid?.();
  assert.equal(typeof uid,'number');
  assert.equal(typeof gid,'number');
  const unsafeSocket=join(scratch,'unsafe-socket.sock');
  const unsafe=spawn(
    binary,
    [
      `--socket=${unsafeSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      '--unsafe-test-same-uid',
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let unsafeStderr='';
  unsafe.stderr.setEncoding('utf8');
  unsafe.stderr.on('data',chunk=>{unsafeStderr+=String(chunk);});
  const unsafeCode=await new Promise<number|null>((resolve,reject)=>{
    unsafe.once('error',reject);
    unsafe.once('close',resolve);
  });
  assert.notEqual(unsafeCode,0);
  assert.match(unsafeStderr,/unsafe same-uid mode is stdio-only/);

  const sameSocket=join(scratch,'same-credential.sock');
  const same=spawn(
    binary,
    [
      `--socket=${sameSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${uid}`,
      `--task-gid=${gid}`,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let sameStderr='';
  same.stderr.setEncoding('utf8');
  same.stderr.on('data',chunk=>{sameStderr+=String(chunk);});
  const sameCode=await new Promise<number|null>((resolve,reject)=>{
    same.once('error',reject);
    same.once('close',resolve);
  });
  assert.notEqual(sameCode,0);
  assert.match(sameStderr,/task uid must differ from executor uid/);

  const sameGidSocket=join(scratch,'same-gid.sock');
  const sameGid=spawn(
    binary,
    [
      `--socket=${sameGidSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${uid!+1}`,
      `--task-gid=${gid}`,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let sameGidStderr='';
  sameGid.stderr.setEncoding('utf8');
  sameGid.stderr.on('data',chunk=>{sameGidStderr+=String(chunk);});
  const sameGidCode=await new Promise<number|null>((resolve,reject)=>{
    sameGid.once('error',reject);
    sameGid.once('close',resolve);
  });
  assert.notEqual(sameGidCode,0);
  assert.match(sameGidStderr,/task gid must differ from executor gid/);

  const socketGroup=gid!+1;
  const overlapSocket=join(scratch,'socket-group-overlap.sock');
  const overlap=spawn(
    binary,
    [
      `--socket=${overlapSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${uid!+1}`,
      `--task-gid=${socketGroup}`,
      `--socket-gid=${socketGroup}`,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let overlapStderr='';
  overlap.stderr.setEncoding('utf8');
  overlap.stderr.on('data',chunk=>{overlapStderr+=String(chunk);});
  const overlapCode=await new Promise<number|null>((resolve,reject)=>{
    overlap.once('error',reject);
    overlap.once('close',resolve);
  });
  assert.notEqual(overlapCode,0);
  assert.match(overlapStderr,/task gid must differ from trusted socket gid/);

  const foreignUID=uid===65532?65531:65532;
  const foreignGID=gid===65532?65531:65532;
  const writableSocket=join(tmpdir(),`overcenter-world-writable-${executorSequence++}.sock`);
  rmSync(writableSocket,{force:true});
  const writable=spawn(
    binary,
    [
      `--socket=${writableSocket}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${foreignUID}`,
      `--task-gid=${foreignGID}`,
      ...attestationArgs,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let writableStderr='';
  writable.stderr.setEncoding('utf8');
  writable.stderr.on('data',chunk=>{writableStderr+=String(chunk);});
  const writableCode=await new Promise<number|null>((resolve,reject)=>{
    writable.once('error',reject);
    writable.once('close',resolve);
  });
  assert.notEqual(writableCode,0);
  assert.match(writableStderr,/task must not be able to write socket directory/);
});

test('production executor receives only explicit task environment',async()=>{
  process.env.GITHUB_TOKEN='host-secret-that-must-not-cross';
  const execution=computationExecution(
    permit(1),
    spec('env','',{env:{SAFE:'yes'}}),
  );
  const harness=await startExecutor(2);
  const {client}=harness;
  try {
    const evidence=await client.execute(execution);
    assertComputationEvidenceFor(evidence,execution);
    assert.equal(evidence.outcome,'completed');
    const environment=JSON.parse(
      Buffer.from(evidence.stdout_base64!,'base64').toString('utf8'),
    ) as Record<string,string>;
    assert.deepEqual(environment,{SAFE:'yes'});
    assert.equal(environment.GITHUB_TOKEN,undefined);
  } finally {
    await harness.close();
    delete process.env.GITHUB_TOKEN;
  }
});

test('bounded capture retains full-stream digests',async()=>{
  const execution=computationExecution(
    permit(2),
    spec('large','4096',{stdoutMax:64,stderrMax:32}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const evidence=await client.execute(execution);
    assert.equal(evidence.outcome,'completed');
    assert.equal(Buffer.from(evidence.stdout_base64!,'base64').length,64);
    assert.equal(Buffer.from(evidence.stderr_base64!,'base64').length,32);
    assert.equal(evidence.stdout_truncated,true);
    assert.equal(evidence.stderr_truncated,true);
    assert.equal(evidence.stdout_sha256,'sha256:'+sha256('x'.repeat(4096)));
    assert.equal(evidence.stderr_sha256,'sha256:'+sha256('y'.repeat(4096)));
    assert.throws(
      ()=>assertComputationEvidenceFor({
        ...evidence,
        stdout_base64:Buffer.from('z'.repeat(65)).toString('base64'),
      },execution),
      /COMPUTATION_EVIDENCE_STDOUT_BASE64_INVALID/,
    );
  } finally {
    await harness.close();
  }
});

test('trusted evidence accepts captures above the process-spec byte limit',async()=>{
  const size=1024*1024+37;
  const execution=computationExecution(
    permit(22),
    spec('large',String(size),{stdoutMax:size,stderrMax:0}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const evidence=await client.execute(execution);
    assert.equal(evidence.outcome,'completed');
    assert.equal(Buffer.from(evidence.stdout_base64!,'base64').length,size);
    assert.equal(evidence.stdout_truncated,false);
    assert.equal(evidence.stdout_sha256,'sha256:'+sha256('x'.repeat(size)));
    assert.equal(evidence.stderr_base64,undefined);
    assert.equal(evidence.stderr_truncated,true);
    assert.equal(evidence.stderr_sha256,'sha256:'+sha256('y'.repeat(size)));
  } finally {
    await harness.close();
  }
});

test('exact spec bytes cannot change under an old digest',()=>{
  const execution=computationExecution(permit(3),spec('env'));
  const bytes=Buffer.from(execution.execution_spec_base64,'base64');
  bytes[bytes.length-2]^=1;
  assert.throws(
    ()=>validateComputationExecution({
      ...execution,
      execution_spec_base64:bytes.toString('base64'),
    }),
    /EXECUTION_SPEC_DIGEST_MISMATCH/,
  );
});

test('test workload crosses Go but settles only by independent observation',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`test-workload-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const output=join(workdir,'result.txt');
  const processSpec=spec('write-file','passed',{
    pidFile:output,
    timeoutMs:5000,
  });
  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      process_spec:processSpec,
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const harness=await startExecutor(1,workdir);
  try {
    const result=await runReadyTestComputation(state.kernel,harness.client);
    assert.ok(result);
    assert.equal(result.state,'DONE');
    assert.equal(result.execution_generation,1);
    assert.equal(result.evidence?.outcome,'completed');
    assert.equal(state.kernel.inspect()[0]?.status,'DONE');
    assert.equal(result.receipt.verified,true);
    assert.equal(readFileSync(output,'utf8'),'passed');

    const summary=(result.receipt.diagnostic as {
      computation_attempt?:Record<string,unknown>;
    }|undefined)?.computation_attempt;
    assert.ok(summary);
    assert.equal(summary.execution_generation,1);
    assert.equal(summary.execution_spec_sha256,result.execution_spec_sha256);
    assert.equal(summary.stdout_sha256,result.evidence?.stdout_sha256);
    assert.equal('stdout_base64' in summary,false);
    assertNoEffectReservations(state.repo);
  } finally {
    await harness.close();
  }
});

test('failed process evidence cannot turn a forged marker into DONE',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`failed-marker-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const output=join(workdir,'result.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      process_spec:{
        schema:PROCESS_SPEC_SCHEMA,
        executable:process.execPath,
        argv:[
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(output)},'passed'); process.exit(1)`,
        ],
        cwd:'.',
        env:{},
        timeout_ms:5000,
        stdout_max_bytes:4096,
        stderr_max_bytes:4096,
      },
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const harness=await startExecutor(1,workdir);
  try {
    const result=await runReadyTestComputation(state.kernel,harness.client);
    assert.ok(result);
    assert.equal(result.evidence?.outcome,'failed');
    assert.equal(result.evidence?.exit_code,1);
    assert.equal(readFileSync(output,'utf8'),'passed');
    assert.equal(result.state,'RECOVERY_REQUIRED');
    assert.equal(result.receipt.verified,false);
    assert.equal(state.kernel.inspect()[0]?.status,'RECOVERY_REQUIRED');
    assertNoEffectReservations(state.repo);
  } finally {
    await harness.close();
  }
});

test('successful process evidence is not project truth',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`test-observation-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const output=join(workdir,'never-created.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      process_spec:{
        schema:PROCESS_SPEC_SCHEMA,
        executable:'/bin/true',
        argv:[],
        cwd:'.',
        env:{},
        timeout_ms:1000,
        stdout_max_bytes:0,
        stderr_max_bytes:0,
      },
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const harness=await startExecutor(1,workdir);
  try {
    const result=await runReadyTestComputation(state.kernel,harness.client);
    assert.ok(result);
    assert.equal(result.evidence?.outcome,'completed');
    assert.equal(result.evidence?.exit_code,0);
    assert.equal(result.state,'READY');
    assert.equal(result.receipt.verified,false);
    assert.equal(state.kernel.inspect()[0]?.status,'READY');
    assertNoEffectReservations(state.repo);
  } finally {
    await harness.close();
  }
});

test('executor death reconstructs test work with a fresh generation and workspace',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`test-recovery-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const oldOnly=join(workdir,'old-workspace-only');
  writeFileSync(oldOnly,'old');
  const output=join(workdir,'result.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:testExecutionContext,
      process_spec:spec('delayed-write-file','passed',{
        pidFile:output,
        timeoutMs:5000,
      }),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const first=await startExecutor(1,workdir);
  const pending=runReadyTestComputation(state.kernel,first.client);
  await new Promise(resolve=>setTimeout(resolve,100));
  await first.abort();
  const interrupted=await pending;
  assert.ok(interrupted);
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');
  assert.equal(interrupted.execution_generation,1);
  assert.equal(interrupted.evidence,undefined);
  assert.ok(interrupted.transport_error);
  assert.equal(state.kernel.inspect()[0]?.status,'RECOVERY_REQUIRED');
  assert.equal(existsSync(output),false);
  assertNoEffectReservations(state.repo);

  const recoveredKernel=new GitOvercenterKernel(state.repo);
  const recoveredProjection=recoveredKernel.inspect()[0]!;
  assert.equal(recoveredProjection.status,'RECOVERY_REQUIRED');
  assert.equal(recoveredProjection.execution_generation,1);

  rmSync(workdir,{recursive:true,force:true});
  mkdirSync(workdir,{recursive:true});
  assert.equal(existsSync(oldOnly),false);

  const second=await startExecutor(1,workdir);
  try {
    await assert.rejects(
      resumeTestComputation(
        recoveredKernel,
        second.client,
        interrupted.run_id,
      ),
      /TEST_COMPUTATION_CONTAINMENT_TERMINATION_UNPROVEN/,
    );
    assert.equal(recoveredKernel.inspect()[0]?.execution_generation,1);

    const priorPid=first.child.pid;
    assert.equal(typeof priorPid,'number');
    const recovered=await resumeTestComputation(
      recoveredKernel,
      second.client,
      interrupted.run_id,
      {
        assertTerminated:async containmentId=>{
          assert.equal(containmentId,`process:${priorPid}`);
          assert.equal(alive(priorPid!),false);
        },
      },
    );
    assert.equal(recovered.state,'DONE');
    assert.equal(recovered.execution_generation,2);
    assert.equal(recovered.evidence?.execution_generation,2);
    assert.equal(
      recovered.execution_spec_sha256,
      interrupted.execution_spec_sha256,
    );
    assert.equal(recoveredKernel.inspect()[0]?.status,'DONE');
    assert.equal(readFileSync(output,'utf8'),'passed');
    assertNoEffectReservations(state.repo);
  } finally {
    await second.close();
  }
});

test('legacy computation cannot replay without a bound execution context',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`legacy-replay-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const output=join(workdir,'result.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      process_spec:spec('delayed-write-file','passed',{
        pidFile:output,
        timeoutMs:5000,
      }),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const first=await startExecutor(1,workdir);
  const pending=runReadyTestComputation(state.kernel,first.client);
  await new Promise(resolve=>setTimeout(resolve,100));
  await first.abort();
  const interrupted=await pending;
  assert.ok(interrupted);
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');

  await assert.rejects(
    resumeTestComputation(state.kernel,{
      executionContextSha256:testExecutionContext,
      execute:async()=>{ throw new Error('must not execute'); },
    },interrupted.run_id),
    /TEST_COMPUTATION_REPLAY_IDENTITY_UNPROVEN/,
  );
  assert.equal(state.kernel.inspect()[0]?.execution_generation,1);
});

test('replay-safe computation rejects a changed execution context before rotating generation',async()=>{
  const state=kernelFixture();
  const workdir=join(scratch,`context-mismatch-${executorSequence++}`);
  mkdirSync(workdir,{recursive:true});
  const output=join(workdir,'result.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:testExecutionContext,
      process_spec:spec('delayed-write-file','passed',{
        pidFile:output,
        timeoutMs:5000,
      }),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const first=await startExecutor(1,workdir,testExecutionContext);
  const pending=runReadyTestComputation(state.kernel,first.client);
  await new Promise(resolve=>setTimeout(resolve,100));
  await first.abort();
  const interrupted=await pending;
  assert.ok(interrupted);
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');

  const wrong='sha256:'+sha256('different-execution-context');
  await assert.rejects(
    resumeTestComputation(state.kernel,{
      executionContextSha256:wrong,
      execute:async()=>{ throw new Error('must not execute'); },
    },interrupted.run_id),
    /TEST_COMPUTATION_EXECUTION_CONTEXT_MISMATCH/,
  );
  assert.equal(state.kernel.inspect()[0]?.execution_generation,1);
});

test('an effectful run cannot enter replayable-computation recovery',async()=>{
  const state=kernelFixture();
  const output=join(scratch,`effectful-launder-${executorSequence++}.txt`);
  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:testExecutionContext,
      process_spec:{
        schema:PROCESS_SPEC_SCHEMA,
        executable:'/bin/true',
        argv:[],
        cwd:'.',
        env:{},
        timeout_ms:1000,
        stdout_max_bytes:0,
        stderr_max_bytes:0,
      },
    },
    postcondition:{
      verifier:'eventually-consistent-file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  const loop=await runGitCoreLoop(state.kernel,{
    effect:async()=>({kind:'effectful-test',may_have_mutated:true}),
    maxAdvances:1,
  });
  assert.equal(loop.state,'RECOVERY_REQUIRED');
  assert.ok(loop.run);
  assert.equal(state.kernel.hasUnresolvedEffect(loop.run),true);

  await assert.rejects(
    resumeTestComputation(state.kernel,{
      executionContextSha256:testExecutionContext,
      containmentId:'trusted-test-containment',
      execute:async()=>{ throw new Error('must not execute'); },
    },loop.run),
    /TEST_COMPUTATION_EFFECT_RESERVATION_PRESENT/,
  );
  assert.equal(state.kernel.inspect()[0]?.execution_generation,1);
});

test('invalid test computation packet fails before durable claim',async()=>{
  const state=kernelFixture();
  const output=join(scratch,`invalid-${executorSequence++}.txt`);
  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      process_spec:{
        schema:PROCESS_SPEC_SCHEMA,
        executable:'relative-executable',
        argv:[],
        cwd:'.',
        env:{},
        timeout_ms:1000,
        stdout_max_bytes:0,
        stderr_max_bytes:0,
      },
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:output,
      content:'passed',
    },
  });

  await assert.rejects(
    runReadyTestComputation(state.kernel,{
      execute:async()=>{
        throw new Error('executor must not be reached');
      },
    }),
    /EXECUTABLE_MUST_BE_ABSOLUTE/,
  );
  const projected=state.kernel.inspect()[0]!;
  assert.equal(projected.status,'READY');
  assert.equal(projected.run_id,undefined);
  assert.deepEqual(state.kernel.receipts(),[]);
});

test('stale exact-generation cancel cannot hit a newer execution',async()=>{
  const current=computationExecution(
    permit(4,2,'authority-4-g2'),
    spec('sleep','finished',{timeoutMs:2000}),
  );
  const stale={
    ...current,
    execution_generation:1,
    execution_authority_commit:'authority-4-g1',
  };
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const pending=client.execute(current);
    await new Promise(resolve=>setTimeout(resolve,50));
    await client.cancel(stale);
    const evidence=await pending;
    assert.equal(evidence.outcome,'completed');
    assert.equal(
      Buffer.from(evidence.stdout_base64!,'base64').toString('utf8'),
      'finished',
    );
  } finally {
    await harness.close();
  }
});

test('delimiter-shaped identity fields cannot alias another live execution',async()=>{
  const firstPermit={
    ...permit(40,2,'c'),
    id:'a/1',
  };
  const secondPermit={
    ...permit(41,1,'2/c'),
    id:'a',
  };
  const first=computationExecution(
    firstPermit,
    spec('sleep','first',{timeoutMs:2000}),
  );
  const second=computationExecution(
    secondPermit,
    spec('sleep','second',{timeoutMs:2000}),
  );
  assert.notEqual(
    executionIdentityKey({
      run_id:first.run_id,
      execution_generation:first.execution_generation,
      execution_authority_commit:first.execution_authority_commit,
    }),
    executionIdentityKey({
      run_id:second.run_id,
      execution_generation:second.execution_generation,
      execution_authority_commit:second.execution_authority_commit,
    }),
  );

  const harness=await startExecutor(2);
  const {client}=harness;
  try {
    const firstPending=client.execute(first);
    const secondPending=client.execute(second);
    await new Promise(resolve=>setTimeout(resolve,50));
    await client.cancel(first);

    const [firstEvidence,secondEvidence]=await Promise.all([firstPending,secondPending]);
    assert.equal(firstEvidence.outcome,'cancelled');
    assert.equal(secondEvidence.outcome,'completed');
    assert.equal(
      Buffer.from(secondEvidence.stdout_base64!,'base64').toString('utf8'),
      'second',
    );
  } finally {
    await harness.close();
  }
});

test('exact cancellation kills SIGTERM-resistant parent and grandchild',async()=>{
  const pidFile=join(workspace,'tree.pid');
  rmSync(pidFile,{force:true});
  const execution=computationExecution(
    permit(5),
    spec('tree-ignore-term','',{pidFile,timeoutMs:10_000}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const pending=client.execute(execution);
    const pids=await waitForPidFile(pidFile,2);
    assert.ok(pids.every(alive));
    await client.cancel(execution);
    const evidence=await pending;
    assert.equal(evidence.outcome,'cancelled');
    await assertDead(pids);
  } finally {
    await harness.close();
  }
});

test('cancellation kills a stubborn grandchild even when its parent exits on SIGTERM',async()=>{
  const pidFile=join(workspace,'tree-parent-exits.pid');
  rmSync(pidFile,{force:true});
  const execution=computationExecution(
    permit(6),
    spec('tree-child-ignore-term','',{pidFile,timeoutMs:10_000}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const pending=client.execute(execution);
    const pids=await waitForPidFile(pidFile,2);
    assert.ok(pids.every(alive));
    await client.cancel(execution);
    const evidence=await pending;
    assert.equal(evidence.outcome,'cancelled');
    await assertDead(pids);
  } finally {
    await harness.close();
  }
});

test('normal exit with a detached background descendant fails and cleans before reuse',async()=>{
  const pidFile=join(workspace,'detached-exit.pid');
  rmSync(pidFile,{force:true});
  const execution=computationExecution(
    permit(7),
    spec('detached-child-exit','',{pidFile,timeoutMs:5000}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const evidence=await client.execute(execution);
    const pids=await waitForPidFile(pidFile,2);
    assert.equal(evidence.outcome,'failed');
    assert.match(evidence.error??'',/background descendants/);
    await assertDead(pids);

    const replacement=computationExecution(
      permit(8),
      {
        schema:PROCESS_SPEC_SCHEMA,
        executable:'/bin/true',
        argv:[],
        cwd:'.',
        env:{},
        timeout_ms:1000,
        stdout_max_bytes:0,
        stderr_max_bytes:0,
      },
    );
    const replacementEvidence=await client.execute(replacement);
    assert.equal(replacementEvidence.outcome,'completed');
  } finally {
    await harness.close();
  }
});

test('cancellation reaps a detached process-group escape',async()=>{
  const pidFile=join(workspace,'tree-detached.pid');
  rmSync(pidFile,{force:true});
  const execution=computationExecution(
    permit(9),
    spec('tree-detached-ignore-term','',{pidFile,timeoutMs:10_000}),
  );
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    const pending=client.execute(execution);
    const pids=await waitForPidFile(pidFile,2);
    assert.ok(pids.every(alive));
    await client.cancel(execution);
    const evidence=await pending;
    assert.equal(evidence.outcome,'cancelled');
    await assertDead(pids);
  } finally {
    await harness.close();
  }
});

test('a second executor cannot unlink or steal a live production socket',async()=>{
  const uid=process.getuid?.();
  const gid=process.getgid?.();
  assert.equal(typeof uid,'number');
  assert.equal(typeof gid,'number');
  const taskUID=uid===65532?65531:65532;
  const taskGID=gid===65532?65531:65532;
  const socketPath=join(scratch,`production-${executorSequence++}.sock`);
  rmSync(socketPath,{force:true});

  const original=spawn(
    binary,
    [
      `--socket=${socketPath}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${taskUID}`,
      `--task-gid=${taskGID}`,
      ...attestationArgs,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let originalStderr='';
  original.stderr.setEncoding('utf8');
  original.stderr.on('data',chunk=>{originalStderr+=String(chunk);});

  const deadline=Date.now()+3000;
  while (Date.now()<deadline && !existsSync(socketPath)) {
    if (original.exitCode!==null) {
      throw new Error(`executor exited before socket was ready: ${originalStderr}`);
    }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if (!existsSync(socketPath)) throw new Error(`executor socket never appeared: ${originalStderr}`);

  const challenger=spawn(
    binary,
    [
      `--socket=${socketPath}`,
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      `--task-uid=${taskUID}`,
      `--task-gid=${taskGID}`,
      ...attestationArgs,
    ],
    {stdio:['ignore','ignore','pipe'],env:{}},
  );
  let challengerStderr='';
  challenger.stderr.setEncoding('utf8');
  challenger.stderr.on('data',chunk=>{challengerStderr+=String(chunk);});
  const challengerCode=await new Promise<number|null>((resolve,reject)=>{
    challenger.once('error',reject);
    challenger.once('close',resolve);
  });
  assert.notEqual(challengerCode,0);
  assert.match(challengerStderr,/socket path already exists/);

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency:1,
    executionContextSha256:attestedExecutionContext,
    containmentId:attestedContainmentId,
  });
  await client.ready();
  assert.equal(client.executionContextSha256,attestedExecutionContext);
  assert.equal(client.containmentId,attestedContainmentId);
  await client.close();
  const originalCode=await new Promise<number|null>((resolve,reject)=>{
    if (original.exitCode!==null) {
      resolve(original.exitCode);
      return;
    }
    original.once('error',reject);
    original.once('close',resolve);
  });
  assert.equal(originalCode,0,originalStderr);
});

test('socket attestation mismatch fails before computation authority is used',async()=>{
  const socketPath=join(scratch,`attestation-mismatch-${executorSequence++}.sock`);
  rmSync(socketPath,{force:true});
  const server=createServer(socket=>{
    socket.end(JSON.stringify({
      schema:'overcenter-executor-hello-v1',
      execution_context_sha256:'sha256:'+'0'.repeat(64),
      containment_id:'wrong-containment',
    })+'\n');
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(socketPath,()=>resolve());
  });

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency:1,
    executionContextSha256:attestedExecutionContext,
    containmentId:attestedContainmentId,
  });
  await assert.rejects(client.ready(),/GO_EXECUTOR_ATTESTATION_MISMATCH/);
  await new Promise<void>((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
  });
});

test('clean idle transport death terminalizes the client',async()=>{
  const socketPath=join(scratch,`dead-transport-${executorSequence++}.sock`);
  rmSync(socketPath,{force:true});
  const server=createServer(socket=>socket.end());
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(socketPath,()=>resolve());
  });

  const client=new GoExecutorClient({socketPath,maxConcurrency:1});
  await new Promise(resolve=>setTimeout(resolve,50));
  const execution=computationExecution(
    permit(950),
    {
      schema:PROCESS_SPEC_SCHEMA,
      executable:'/bin/true',
      argv:[],
      cwd:'.',
      env:{},
      timeout_ms:1000,
      stdout_max_bytes:0,
      stderr_max_bytes:0,
    },
  );
  await assert.rejects(
    client.execute(execution),
    /GO_EXECUTOR_SOCKET_CLOSED/,
  );
  await new Promise<void>((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
  });
});

test('completion evidence releases server capacity before replacement work is admitted',async()=>{
  const harness=await startExecutor(1);
  const {client}=harness;
  try {
    for (let index=0;index<64;index+=1) {
      const execution=computationExecution(
        permit(1000+index),
        {
          schema:PROCESS_SPEC_SCHEMA,
          executable:'/bin/true',
          argv:[],
          cwd:'.',
          env:{},
          timeout_ms:1000,
          stdout_max_bytes:0,
          stderr_max_bytes:0,
        },
      );
      const evidence=await client.execute(execution);
      assert.equal(evidence.outcome,'completed');
    }
  } finally {
    await harness.close();
  }
});

test('test computation runner cannot open the provider effect boundary',()=>{
  const source=readFileSync(join(repoRoot,'src/computation-runner.ts'),'utf8');
  for (const forbidden of [
    /beginEffect/,
    /performEffect/,
    /github/i,
    /kubernetes/i,
  ]) {
    assert.equal(forbidden.test(source),false,String(forbidden));
  }
});

test('production Go executor source contains no provider or settlement machinery',()=>{
  const files=[
    'protocol.go',
    'capture.go',
    'process_linux.go',
    'process_supervisor_linux.go',
    'executor.go',
    'cmd/overcenter-executor/main.go',
  ];
  const forbidden=[
    /github/i,
    /kubernetes/i,
    /settle/i,
    /obligation.*done/i,
    /net\/http/,
  ];
  for (const file of files) {
    const source=readFileSync(join(executorDir,file),'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source),false,`${file} contains ${String(pattern)}`);
    }
  }
});
