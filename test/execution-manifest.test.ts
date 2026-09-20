import assert from 'node:assert/strict';
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
};

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
  assert.throws(()=>renderExecutionManifest({...base,args:['ok\nsmuggled']}),/ARG_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,environment:{'BAD-NAME':'x'}}),/ENV_NAME_INVALID/u);
  assert.throws(()=>renderExecutionManifest({...base,runtime_read_only:['/lib/a','/lib/a']}),/RUNTIME_READ_ONLY_DUPLICATE/u);
});

test('trusted launcher receives the exact bytes whose digest is reported',async()=>{
  const rendered=renderExecutionManifest(base);
  const result=await runConfinedWorker({
    launcher:'/bin/cat',
    manifest:base,
  });

  assert.equal(result.exit_code,0);
  assert.equal(result.signal,null);
  assert.equal(result.stderr,'');
  assert.equal(result.stdout,rendered.bytes);
  assert.equal(result.manifest_sha256,sha256(result.stdout));
});

test('launcher identity is configuration, not manifest-controlled',async()=>{
  await assert.rejects(
    runConfinedWorker({launcher:'relative-launcher',manifest:base}),
    /LAUNCHER_NOT_ABSOLUTE/u,
  );
});
