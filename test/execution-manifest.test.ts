import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/digest.ts';
import { runConfinedWorker } from '../src/confined-executor.ts';
import { renderExecutionManifest } from '../src/execution-manifest.ts';

const base={
  task_id:'task-7',
  workspace:'/work/task-7',
  workspace_dev:'2049',
  workspace_ino:'987654',
  program:'/usr/bin/node',
  memory_max_bytes:'2147483648',
  pids_max:'128',
  cpu_quota_us:'200000',
  cpu_period_us:'100000',
};

function runnableManifest(){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'overcenter-exec-'));
  const stat=fs.statSync(workspace,{bigint:true});
  return {
    workspace,
    manifest:{
      ...base,
      workspace,
      workspace_dev:stat.dev.toString(),
      workspace_ino:stat.ino.toString(),
    },
  };
}

test('execution manifest is canonical and digest-bound',()=>{
  const rendered=renderExecutionManifest({
    ...base,
    args:['worker.mjs','--mode=safe'],
    environment:{ZED:'z',ALPHA:'a'},
    runtime_read_only:['/lib/libc.so.6','/etc/ld.so.cache'],
    runtime_executable:['/lib64/ld-linux-x86-64.so.2'],
  });

  assert.equal(rendered.bytes,[
    'OVERCENTER_EXEC_V1',
    'task_id\ttask-7',
    'workspace\t/work/task-7',
    'workspace_dev\t2049',
    'workspace_ino\t987654',
    'program\t/usr/bin/node',
    'timeout_ms\t60000',
    'max_output_bytes\t1048576',
    'memory_max_bytes\t2147483648',
    'pids_max\t128',
    'cpu_quota_us\t200000',
    'cpu_period_us\t100000',
    'arg\tworker.mjs',
    'arg\t--mode=safe',
    'env\tALPHA\ta',
    'env\tZED\tz',
    'runtime_ro\t/etc/ld.so.cache',
    'runtime_ro\t/lib/libc.so.6',
    'runtime_exec\t/lib64/ld-linux-x86-64.so.2',
    '',
  ].join('\n'));
  assert.equal(rendered.sha256,sha256(rendered.bytes));
  assert.equal(rendered.sha256,renderExecutionManifest({
    ...base,
    args:['worker.mjs','--mode=safe'],
    environment:{ALPHA:'a',ZED:'z'},
    runtime_read_only:['/etc/ld.so.cache','/lib/libc.so.6'],
    runtime_executable:['/lib64/ld-linux-x86-64.so.2'],
  }).sha256);
});

test('execution manifest rejects authority-smearing inputs',()=>{
  assert.throws(()=>renderExecutionManifest({...base,workspace:'relative'}),/WORKSPACE_NOT_ABSOLUTE/u);
  assert.throws(()=>renderExecutionManifest({...base,workspace_dev:'1e3'}),/WORKSPACE_DEV_NOT_DECIMAL/u);
  assert.throws(()=>renderExecutionManifest({...base,workspace_dev:'01'}),/WORKSPACE_DEV_NOT_CANONICAL/u);
  assert.throws(
    ()=>renderExecutionManifest({...base,workspace_dev:'18446744073709551616'}),
    /WORKSPACE_DEV_OUT_OF_RANGE/u,
  );
  assert.throws(()=>renderExecutionManifest({...base,args:['ok\nsmuggled']}),/ARG_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,environment:{'BAD-NAME':'x'}}),/ENV_NAME_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,runtime_read_only:['/lib/a','/lib/a']}),/RUNTIME_READ_ONLY_DUPLICATE/u);
  assert.throws(
    ()=>renderExecutionManifest({...base,runtime_read_only:['/lib/a'],runtime_executable:['/lib/a']}),
    /RUNTIME_ACCESS_CONFLICT/u,
  );
  assert.throws(
    ()=>renderExecutionManifest({...base,timeout_ms:2_147_483_648}),
    /TIMEOUT_MS_INVALID/u,
  );
  assert.throws(()=>renderExecutionManifest({...base,memory_max_bytes:'0'}),/MEMORY_MAX_BYTES_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,pids_max:'0'}),/PIDS_MAX_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,cpu_quota_us:'0'}),/CPU_QUOTA_US_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,cpu_period_us:'0'}),/CPU_PERIOD_US_INVALID/u);
});

test('resource budget is part of execution identity',()=>{
  const ordinary=renderExecutionManifest(base);
  assert.notEqual(
    renderExecutionManifest({...base,memory_max_bytes:'1073741824'}).sha256,
    ordinary.sha256,
  );
  assert.notEqual(renderExecutionManifest({...base,pids_max:'64'}).sha256,ordinary.sha256);
  assert.notEqual(renderExecutionManifest({...base,cpu_quota_us:'100000'}).sha256,ordinary.sha256);
  assert.notEqual(renderExecutionManifest({...base,cpu_period_us:'50000'}).sha256,ordinary.sha256);
});

test('supervisor policy is part of execution identity',()=>{
  const ordinary=renderExecutionManifest(base);
  const tighterTimeout=renderExecutionManifest({...base,timeout_ms:59_999});
  const tighterOutput=renderExecutionManifest({...base,max_output_bytes:1_048_575});
  assert.notEqual(tighterTimeout.sha256,ordinary.sha256);
  assert.notEqual(tighterOutput.sha256,ordinary.sha256);
});

test('execution manifest environment ordering is locale-independent',()=>{
  const rendered=renderExecutionManifest({
    ...base,
    environment:{a:'lower',_Z:'underscore',B:'upper'},
  });
  assert.deepEqual(
    rendered.bytes.split('\n').filter((line)=>line.startsWith('env\t')),
    ['env\tB\tupper','env\t_Z\tunderscore','env\ta\tlower'],
  );
});

test('trusted launcher receives the exact bytes whose digest is reported',async()=>{
  const {workspace,manifest}=runnableManifest();
  try {
    const rendered=renderExecutionManifest(manifest);
    const result=await runConfinedWorker({launcher:'/bin/cat',manifest});
    assert.equal(result.exit_code,0);
    assert.equal(result.signal,null);
    assert.equal(result.stderr,'');
    assert.equal(result.stdout,rendered.bytes);
    assert.equal(result.manifest_sha256,sha256(result.stdout));
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('trusted launcher passes the exact workspace object on fd 3',async()=>{
  const {workspace,manifest}=runnableManifest();
  try {
    const result=await runConfinedWorker({
      launcher:'/bin/sh',
      launcher_args:['-c','/usr/bin/stat -Lc "%d %i" /proc/self/fd/3; /bin/cat'],
      manifest,
    });
    const [identity,...manifestLines]=result.stdout.split('\n');
    assert.equal(identity,`${manifest.workspace_dev} ${manifest.workspace_ino}`);
    assert.equal(`${manifestLines.join('\n')}`,renderExecutionManifest(manifest).bytes);
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('trusted launcher rejects a workspace fd identity mismatch',async()=>{
  const {workspace,manifest}=runnableManifest();
  try {
    await assert.rejects(
      runConfinedWorker({
        launcher:'/bin/cat',
        manifest:{...manifest,workspace_ino:(BigInt(manifest.workspace_ino)+1n).toString()},
      }),
      /WORKSPACE_IDENTITY_CHANGED/u,
    );
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('trusted launcher bounds untrusted output',async()=>{
  const {workspace,manifest}=runnableManifest();
  try {
    await assert.rejects(
      runConfinedWorker({launcher:'/bin/cat',manifest:{...manifest,max_output_bytes:8}}),
      /WORKER_OUTPUT_LIMIT/u,
    );
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('trusted launcher kills a hanging worker process group',async()=>{
  const {workspace,manifest}=runnableManifest();
  const started=Date.now();
  try {
    await assert.rejects(
      runConfinedWorker({
        launcher:'/bin/sh',
        launcher_args:['-c','cat >/dev/null; sleep 5'],
        manifest:{...manifest,timeout_ms:50},
      }),
      /WORKER_TIMEOUT/u,
    );
    assert.ok(Date.now()-started<2_000);
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('launcher budgets fail closed',async()=>{
  await assert.rejects(
    runConfinedWorker({launcher:'/bin/cat',manifest:{...base,timeout_ms:0}}),
    /TIMEOUT_MS_INVALID/u,
  );
  await assert.rejects(
    runConfinedWorker({launcher:'/bin/cat',manifest:{...base,max_output_bytes:0}}),
    /MAX_OUTPUT_BYTES_INVALID/u,
  );
});

test('launcher identity is configuration, not manifest-controlled',async()=>{
  await assert.rejects(
    runConfinedWorker({launcher:'relative-launcher',manifest:base}),
    /LAUNCHER_NOT_ABSOLUTE/u,
  );
});
