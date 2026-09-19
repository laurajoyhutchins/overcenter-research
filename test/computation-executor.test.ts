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
  PROCESS_SPEC_SCHEMA,
  assertComputationEvidenceFor,
  computationExecution,
  validateComputationExecution,
  validateProcessSpec,
  type ProcessSpecV1,
} from '../src/computation-execution.ts';
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

let executorSequence=0;

interface ExecutorHarness {
  client:GoExecutorClient;
  child:ChildProcessWithoutNullStreams;
  close:()=>Promise<void>;
}

async function startExecutor(maxConcurrency:number):Promise<ExecutorHarness> {
  const socketPath=join(scratch,`executor-${executorSequence++}.sock`);
  rmSync(socketPath,{force:true});
  const child=spawn(
    binary,
    [
      `--socket=${socketPath}`,
      `--workspace-root=${workspace}`,
      `--concurrency=${maxConcurrency}`,
    ],
    {stdio:['pipe','pipe','pipe'],env:{}},
  );
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});

  const deadline=Date.now()+3000;
  while (Date.now()<deadline && !existsSync(socketPath)) {
    if (child.exitCode!==null) {
      throw new Error(`executor exited before socket was ready: ${stderr}`);
    }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if (!existsSync(socketPath)) throw new Error(`executor socket never appeared: ${stderr}`);

  const client=new GoExecutorClient({socketPath,maxConcurrency});
  return {
    client,
    child,
    close:async()=>{
      await client.close();
      const code=await new Promise<number|null>((resolve,reject)=>{
        if (child.exitCode!==null) {
          resolve(child.exitCode);
          return;
        }
        child.once('error',reject);
        child.once('close',resolve);
      });
      assert.equal(code,0,stderr);
    },
  };
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

test('production Go executor source contains no provider or settlement machinery',()=>{
  const files=[
    'protocol.go',
    'capture.go',
    'process_linux.go',
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
