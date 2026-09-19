import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
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

import {
  PROCESS_SPEC_SCHEMA,
  type ProcessSpecV1,
} from '../src/computation-execution.ts';
import {
  TEST_COMPUTATION_PACKET_SCHEMA,
  resumeTestComputation,
  runReadyTestComputation,
} from '../src/computation-runner.ts';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import { GoExecutorClient } from '../src/go-executor-client.ts';

const image=process.env.OVERCENTER_EXECUTOR_IMAGE;
if (!image) {
  throw new Error('OVERCENTER_EXECUTOR_IMAGE is required');
}

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const scratch=mkdtempSync(join(tmpdir(),'overcenter-isolated-test-workload-'));
const dockerLabel=`overcenter.computation-test=${process.pid}`;
let sequence=0;

function docker(args:string[],encoding:'utf8'='utf8'):string {
  return execFileSync('docker',args,{encoding});
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
  repo:string;
  kernel:GitOvercenterKernel;
} {
  const root=join(scratch,`kernel-${sequence++}`);
  const repo=join(root,'state.git');
  mkdirSync(root,{recursive:true});
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo,{observationContext:{localFileRoot}});
  kernel.initialize();
  return {repo,kernel};
}

function freshWorkspace(name:string):string {
  const path=join(scratch,name);
  rmSync(path,{recursive:true,force:true});
  mkdirSync(path,{recursive:true});
  chmodSync(path,0o777);
  return path;
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

function realTestSpec(mode:'node-test'|'delayed-node-test'):ProcessSpecV1 {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:'/usr/local/bin/node',
    argv:[
      '/fixture.mjs',
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

async function startIsolatedExecutor(
  workspace:string,
):Promise<IsolatedExecutor> {
  const id=sequence++;
  const control=join(scratch,`control-${id}`);
  mkdirSync(control,{recursive:true});
  chmodSync(control,0o750);
  const socketPath=join(control,'executor.sock');
  const container=`overcenter-test-workload-${process.pid}-${id}`;
  const gid=process.getgid?.();
  if (gid===undefined) throw new Error('host gid unavailable');

  docker([
    'run',
    '-d',
    '--name',
    container,
    '--label',
    dockerLabel,
    '--network=none',
    '--read-only',
    '--entrypoint',
    '/usr/local/bin/overcenter-executor',
    '-v',
    `${control}:/control`,
    '-v',
    `${workspace}:/workspace`,
    '-v',
    `${repoRoot}:/source:ro`,
    image,
    '--socket=/control/executor.sock',
    '--workspace-root=/workspace',
    '--concurrency=1',
    '--task-uid=65532',
    '--task-gid=65532',
    `--socket-gid=${gid}`,
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

  assert.equal(
    docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).trim(),
    'none',
  );
  assert.equal(
    docker(['inspect','--format','{{.HostConfig.ReadonlyRootfs}}',container]).trim(),
    'true',
  );

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency:1,
  });

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

test('confined observation rejects a task-controlled result symlink',async()=>{
  const workspace=freshWorkspace('symlink-result-workspace');
  const state=kernelFixture(workspace);
  const marker=join(workspace,'test-result.txt');
  const outside=join(scratch,'outside-result.txt');
  writeFileSync(outside,'passed');

  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
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
        schema:TEST_COMPUTATION_PACKET_SCHEMA,
        kind:'test',
        process_spec:{
          schema:PROCESS_SPEC_SCHEMA,
          executable:'/usr/local/bin/node',
          argv:[
            '/fixture.mjs',
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
      assert.equal(result.state,'READY');
      assert.equal(existsSync(marker),false);
      assertNoEffectReservations(state.repo);
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
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
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
    assertNoEffectReservations(state.repo);
  } finally {
    await executor.close();
  }
});

test('isolated executor death recovers the real test from durable facts in generation 2',async()=>{
  const workspace=freshWorkspace('recovery-test-workspace');
  const state=kernelFixture(workspace);
  const oldOnly=join(workspace,'old-workspace-only');
  const marker=join(workspace,'test-result.txt');
  writeFileSync(oldOnly,'old');

  state.kernel.define({
    id:'test',
    packet:{
      schema:TEST_COMPUTATION_PACKET_SCHEMA,
      kind:'test',
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
  assertNoEffectReservations(state.repo);

  const recoveredKernel=new GitOvercenterKernel(state.repo,{observationContext:{localFileRoot:workspace}});
  assert.equal(recoveredKernel.inspect()[0]?.status,'RECOVERY_REQUIRED');
  assert.equal(recoveredKernel.inspect()[0]?.execution_generation,1);

  freshWorkspace('recovery-test-workspace');
  assert.equal(existsSync(oldOnly),false);

  const second=await startIsolatedExecutor(workspace);
  try {
    const recovered=await resumeTestComputation(
      recoveredKernel,
      second.client,
      interrupted.run_id,
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
    assertNoEffectReservations(state.repo);
  } finally {
    await second.close();
  }
});
