import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  PROCESS_SPEC_SCHEMA,
  type ProcessSpecV1,
} from '../src/computation-execution.ts';
import {
  REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
  resumeTestComputation,
  runReadyTestComputation,
} from '../src/computation-runner.ts';
import { OvercenterKernel } from '../src/kernel.ts';
import { GoExecutorClient } from '../src/go-executor-client.ts';
import {
  executionContextSha256 as hashExecutionContext,
  sourceTreeSha256,
} from '../src/execution-context.ts';
import {
  PRODUCTION_COMPUTATION_CONTAINMENT,
  productionDockerIsolationArgs,
  productionExecutorArgs,
} from '../src/production-containment.ts';

const image=process.env.OVERCENTER_EXECUTOR_IMAGE;
if (!image) {
  throw new Error('OVERCENTER_EXECUTOR_IMAGE is required');
}

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const scratch=mkdtempSync(join(tmpdir(),'overcenter-isolated-test-workload-'));
const sourceRevision=execFileSync('git',['-C',repoRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceRoot=join(scratch,'source');
mkdirSync(sourceRoot,{recursive:true});
const sourceArchive=execFileSync(
  'git',
  ['-C',repoRoot,'archive','--format=tar',sourceRevision],
  {maxBuffer:64*1024*1024},
);
const sourceExtract=spawnSync('tar',['-xf','-','-C',sourceRoot],{input:sourceArchive});
if (sourceExtract.status!==0) {
  throw new Error(`source snapshot extraction failed: ${sourceExtract.stderr?.toString('utf8')??''}`);
}
const dockerLabel=`overcenter.computation-test=${process.pid}`;
const containerProfile=PRODUCTION_COMPUTATION_CONTAINMENT;
let sequence=0;

function docker(args:string[],encoding:'utf8'='utf8'):string {
  return execFileSync('docker',args,{encoding});
}

function executionContextSha256(mountedSourceRoot=sourceRoot):string {
  const imageId=docker(['image','inspect',image!,'--format','{{.Id}}']).trim();
  return hashExecutionContext({
    schema:'overcenter-test-execution-context-v1',
    image_id:imageId,
    source_revision:sourceRevision,
    source_tree_sha256:sourceTreeSha256(mountedSourceRoot),
    containment:containerProfile,
  });
}

after(()=>{
  try {
    const ids=docker([
      'ps',
      '-aq',
      '--filter',
      `label=${dockerLabel}`,
    ]).trim().split(/\s+/).filter(Boolean);
    if (ids.length>0) {
      execFileSync('docker',['rm','-f',...ids],{stdio:'ignore'});
    }
  } finally {
    rmSync(scratch,{recursive:true,force:true});
  }
});

function kernelFixture(localFileRoot:string):{
  db:string;
  kernel:OvercenterKernel;
} {
  const root=join(scratch,`kernel-${sequence++}`);
  const db=join(root,'state.sqlite');
  mkdirSync(root,{recursive:true});
  const kernel=new OvercenterKernel(db,{observationContext:{localFileRoot}});
  kernel.initialize();
  return {db,kernel};
}

function freshWorkspace(name:string):string {
  const path=join(scratch,name);
  rmSync(path,{recursive:true,force:true});
  mkdirSync(path,{recursive:true});
  chmodSync(path,0o777);
  return path;
}

function assertNoEffectReservations(dbPath:string):void {
  const db=new DatabaseSync(dbPath);
  try {
    const row=db.prepare(`
      SELECT COUNT(*) AS count
      FROM fact_commits
      WHERE instr(files_json, '"effect-reservation.json"') > 0
    `).get() as {count:number|bigint};
    assert.equal(Number(row.count),0);
  } finally {
    db.close();
  }
}

function realTestSpec(mode:'node-test'|'delayed-node-test'):ProcessSpecV1 {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:'/usr/local/bin/node',
    argv:[
      '--experimental-strip-types',
      '/fixture.ts',
      mode,
      '/source/test/digest-pure.test.ts',
      '/workspace/test-result.txt',
    ],
    cwd:'.',
    env:{},
    timeout_ms:30_000,
    stdout_max_bytes:256*1024,
    stderr_max_bytes:256*1024,
  };
}

interface IsolatedExecutor {
  client:GoExecutorClient;
  close:()=>Promise<void>;
  abort:()=>Promise<void>;
}

interface IsolatedExecutorOptions {
  sourceRoot?:string;
}

async function startIsolatedExecutor(
  workspace:string,
  options:IsolatedExecutorOptions={},
):Promise<IsolatedExecutor> {
  if (readdirSync(workspace).length!==0) {
    throw new Error('PRODUCTION_COMPUTATION_WORKSPACE_MUST_START_EMPTY');
  }
  const id=sequence++;
  const control=join(scratch,`control-${id}`);
  mkdirSync(control,{recursive:true});
  chmodSync(control,0o750);
  const socketPath=join(control,'executor.sock');
  const container=`overcenter-test-workload-${process.pid}-${id}`;
  const containmentId=`overcenter-containment-${randomUUID()}`;
  const mountedSourceRoot=options.sourceRoot??sourceRoot;
  const contextSha256=executionContextSha256(mountedSourceRoot);
  const gid=process.getgid?.();
  if (gid===undefined) throw new Error('host gid unavailable');

  docker([
    'run',
    '-d',
    '--name',
    container,
    '--label',
    dockerLabel,
    '--label',
    `overcenter.containment=${containmentId}`,
    ...productionDockerIsolationArgs(),
    '--entrypoint',
    '/usr/local/bin/overcenter-executor',
    '-v',
    `${control}:/control`,
    '-v',
    `${workspace}:/workspace`,
    '-v',
    `${mountedSourceRoot}:/source:ro`,
    image,
    ...productionExecutorArgs({
      socketPath:'/control/executor.sock',
      workspaceRoot:'/workspace',
      socketGid:gid,
      executionContextSha256:contextSha256,
      containmentId,
    }),
  ]);

  const deadline=Date.now()+10_000;
  while (!existsSync(socketPath) && Date.now()<deadline) {
    const running=docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      container,
    ]).trim();
    if (running!=='true') {
      const logs=docker(['logs',container]);
      throw new Error(`isolated executor exited before socket ready: ${logs}`);
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if (!existsSync(socketPath)) {
    throw new Error('isolated executor socket never appeared');
  }

  const hostConfig=JSON.parse(
    docker(['inspect','--format','{{json .HostConfig}}',container]),
  ) as {
    NetworkMode:string;
    ReadonlyRootfs:boolean;
    SecurityOpt:string[]|null;
    CapDrop:string[]|null;
    CapAdd:string[]|null;
    PidsLimit:number;
    Memory:number;
    MemorySwap:number;
    NanoCpus:number;
    Ulimits:Array<{Name:string;Soft:number;Hard:number}>|null;
    Tmpfs:Record<string,string>|null;
  };
  assert.equal(hostConfig.NetworkMode,containerProfile.network);
  assert.equal(hostConfig.ReadonlyRootfs,true);
  assert.ok(
    hostConfig.SecurityOpt?.some(option=>option==='no-new-privileges' || option==='no-new-privileges:true'),
  );
  assert.deepEqual(hostConfig.CapDrop,['ALL']);
  assert.deepEqual(
    new Set((hostConfig.CapAdd??[]).map(capability=>capability.replace(/^CAP_/,'').toUpperCase())),
    new Set(containerProfile.cap_add),
  );
  assert.equal(hostConfig.PidsLimit,containerProfile.pids_limit);
  assert.equal(hostConfig.Memory,containerProfile.memory_bytes);
  assert.equal(hostConfig.MemorySwap,containerProfile.memory_swap_bytes);
  assert.equal(hostConfig.NanoCpus,containerProfile.nano_cpus);
  const ulimits=new Map((hostConfig.Ulimits??[]).map(limit=>[limit.Name,limit]));
  assert.equal(ulimits.get('nofile')?.Soft,containerProfile.nofile);
  assert.equal(ulimits.get('fsize')?.Soft,containerProfile.file_size_bytes);
  const tmpfsOptions=new Set(
    (hostConfig.Tmpfs?.[containerProfile.tmpfs.path]??'').split(',').filter(Boolean),
  );
  for (const option of containerProfile.tmpfs.options.split(',')) {
    assert.ok(tmpfsOptions.has(option),`missing tmpfs option: ${option}`);
  }

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency:1,
    executionContextSha256:contextSha256,
    containmentId,
  });
  await client.ready();
  assert.equal(client.executionContextSha256,contextSha256);
  assert.equal(client.containmentId,containmentId);

  const remove=():void=>{
    try {
      execFileSync('docker',['rm',container],{stdio:'ignore'});
    } catch {
      // after() is the final cleanup backstop.
    }
  };

  return {
    client,
    close:async()=>{
      await client.close();
      const code=Number.parseInt(docker(['wait',container]).trim(),10);
      assert.equal(code,0,docker(['logs',container]));
      remove();
    },
    abort:async()=>{
      try {
        execFileSync('docker',['kill',container],{stdio:'ignore'});
      } finally {
        try {
          docker(['wait',container]);
        } finally {
          remove();
        }
      }
    },
  };
}

test('production source snapshot excludes Git metadata and checkout credentials',()=>{
  assert.equal(existsSync(join(sourceRoot,'.git')),false);
  assert.ok(existsSync(join(sourceRoot,'package.json')));
});

test('production computation refuses a pre-populated writable workspace',async()=>{
  const workspace=freshWorkspace('prepopulated-workspace');
  writeFileSync(join(workspace,'payload.ts'),'process.exit(0)');
  await assert.rejects(
    startIsolatedExecutor(workspace),
    /PRODUCTION_COMPUTATION_WORKSPACE_MUST_START_EMPTY/,
  );
});

test('confined observation rejects a task-controlled result symlink',async()=>{
  const workspace=freshWorkspace('symlink-result-workspace');
  const state=kernelFixture(workspace);
  const marker=join(workspace,'test-result.txt');
  const outside=join(scratch,'outside-result.txt');
  writeFileSync(outside,'passed');

  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:executionContextSha256(),
      process_spec:realTestSpec('node-test'),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:marker,
      content:'passed',
    },
  });

  symlinkSync('../outside-result.txt',marker);
  assert.equal(lstatSync(marker).isSymbolicLink(),true);
  assert.equal(readlinkSync(marker),'../outside-result.txt');

  const work=state.kernel.deriveReadyWork();
  assert.ok(work);
  const permit=state.kernel.claim(work.id,work.revision);
  const receipt=state.kernel.resolve(permit);
  assert.equal(receipt.disposition,'RECOVERY_REQUIRED');
  assert.equal(receipt.verified,false);
  assert.equal(state.kernel.inspect()[0]?.status,'RECOVERY_REQUIRED');
});

test('production computation cannot emit a network effect',async()=>{
  let effects=0;
  const server=createServer((request,response)=>{
    if (request.method==='POST') effects+=1;
    request.resume();
    response.end('ok');
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'0.0.0.0',()=>resolve());
  });

  try {
    const address=server.address() as AddressInfo;
    const gateway=docker([
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ]).trim();
    assert.ok(gateway);

    const workspace=freshWorkspace('network-denied-workspace');
    const state=kernelFixture(workspace);
    const marker=join(workspace,'test-result.txt');
    state.kernel.define({
      id:'test',
      packet:{
        schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
        kind:'test',
        execution_context_sha256:executionContextSha256(),
        process_spec:{
          schema:PROCESS_SPEC_SCHEMA,
          executable:'/usr/local/bin/node',
          argv:[
            '--experimental-strip-types',
            '/fixture.ts',
            'network-effect-then-write',
            `http://${gateway}:${address.port}/effect`,
            '/workspace/test-result.txt',
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
        path:marker,
        content:'passed',
      },
    });

    const executor=await startIsolatedExecutor(workspace);
    try {
      const result=await runReadyTestComputation(state.kernel,executor.client);
      assert.ok(result);
      assert.equal(effects,0,'isolated computation must not reach the host network');
      assert.equal(result.state,'RECOVERY_REQUIRED');
      assert.equal(result.receipt.verified,false);
      assert.equal(existsSync(marker),false);
      assertNoEffectReservations(state.db);
    } finally {
      await executor.close();
    }
  } finally {
    await new Promise<void>((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve());
    });
  }
});

test('real test workload runs through the isolated production socket and settles by observation',async()=>{
  const workspace=freshWorkspace('real-test-workspace');
  const state=kernelFixture(workspace);
  const marker=join(workspace,'test-result.txt');
  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:executionContextSha256(),
      process_spec:realTestSpec('node-test'),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:marker,
      content:'passed',
    },
  });

  const executor=await startIsolatedExecutor(workspace);
  try {
    const result=await runReadyTestComputation(state.kernel,executor.client);
    assert.ok(result);
    assert.equal(result.state,'DONE');
    assert.equal(result.evidence?.outcome,'completed');
    assert.equal(readFileSync(marker,'utf8'),'passed');
    const stat=statSync(marker);
    assert.equal(stat.uid,65532);
    assert.equal(stat.gid,65532);
    assert.equal(state.kernel.inspect()[0]?.status,'DONE');
    assertNoEffectReservations(state.db);
  } finally {
    await executor.close();
  }
});

test('isolated executor death recovers the real test from durable facts in generation 2',async()=>{
  const workspace=freshWorkspace('recovery-test-workspace');
  const state=kernelFixture(workspace);
  const marker=join(workspace,'test-result.txt');

  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:executionContextSha256(),
      process_spec:realTestSpec('delayed-node-test'),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:marker,
      content:'passed',
    },
  });

  const first=await startIsolatedExecutor(workspace);
  const pending=runReadyTestComputation(state.kernel,first.client);
  await new Promise(resolve=>setTimeout(resolve,100));
  await first.abort();

  const interrupted=await pending;
  assert.ok(interrupted);
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');
  assert.equal(interrupted.execution_generation,1);
  assert.equal(interrupted.evidence,undefined);
  assert.equal(existsSync(marker),false);
  assertNoEffectReservations(state.db);

  state.kernel.close();
  const recoveredKernel=new OvercenterKernel(state.db,{observationContext:{localFileRoot:workspace}});
  assert.equal(recoveredKernel.inspect()[0]?.status,'RECOVERY_REQUIRED');
  assert.equal(recoveredKernel.inspect()[0]?.execution_generation,1);

  freshWorkspace('recovery-test-workspace');
  assert.deepEqual(readdirSync(workspace),[]);

  const second=await startIsolatedExecutor(workspace);
  try {
    const recovered=await resumeTestComputation(
      recoveredKernel,
      second.client,
      interrupted.run_id,
      {
        assertTerminated:async priorContainmentId=>{
          const remaining=docker([
            'ps','-aq','--filter',`label=overcenter.containment=${priorContainmentId}`,
          ]).trim();
          assert.equal(remaining,'');
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
    assert.equal(readFileSync(marker,'utf8'),'passed');
    const stat=statSync(marker);
    assert.equal(stat.uid,65532);
    assert.equal(stat.gid,65532);
    assert.equal(recoveredKernel.inspect()[0]?.status,'DONE');
    assertNoEffectReservations(state.db);
  } finally {
    await second.close();
  }
});


test('production recovery rejects substituted source bytes before generation rotation',async()=>{
  const workspace=freshWorkspace('substituted-source-recovery-workspace');
  const state=kernelFixture(workspace);
  const marker=join(workspace,'test-result.txt');
  const originalContext=executionContextSha256();

  state.kernel.define({
    id:'test',
    packet:{
      schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
      execution_context_sha256:originalContext,
      process_spec:realTestSpec('delayed-node-test'),
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:marker,
      content:'passed',
    },
  });

  const first=await startIsolatedExecutor(workspace);
  const pending=runReadyTestComputation(state.kernel,first.client);
  await new Promise(resolve=>setTimeout(resolve,100));
  await first.abort();

  const interrupted=await pending;
  assert.ok(interrupted);
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');
  assert.equal(interrupted.execution_generation,1);
  assert.equal(existsSync(marker),false);

  state.kernel.close();
  const recoveredKernel=new OvercenterKernel(state.db,{observationContext:{localFileRoot:workspace}});
  assert.equal(recoveredKernel.inspect()[0]?.execution_generation,1);

  freshWorkspace('substituted-source-recovery-workspace');
  const substitutedSourceRoot=join(scratch,`substituted-source-${sequence++}`);
  mkdirSync(join(substitutedSourceRoot,'test'),{recursive:true});
  const originalSource=readFileSync(join(sourceRoot,'test/digest-pure.test.ts'),'utf8');
  const substitutedSource="throw new Error('substituted source must never execute');\n";
  writeFileSync(join(substitutedSourceRoot,'test/digest-pure.test.ts'),substitutedSource);
  assert.notEqual(substitutedSource,originalSource);

  const substitutedContext=executionContextSha256(substitutedSourceRoot);
  assert.notEqual(substitutedContext,originalContext);
  const second=await startIsolatedExecutor(workspace,{
    sourceRoot:substitutedSourceRoot,
  });
  try {
    await assert.rejects(
      resumeTestComputation(
        recoveredKernel,
        second.client,
        interrupted.run_id,
      ),
      /TEST_COMPUTATION_EXECUTION_CONTEXT_MISMATCH/,
    );
    const projected=recoveredKernel.inspect()[0]!;
    assert.equal(projected.status,'RECOVERY_REQUIRED');
    assert.equal(projected.execution_generation,1);
    assert.equal(existsSync(marker),false);
  } finally {
    await second.close();
  }
});
