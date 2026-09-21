import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { runConfinedWorker } from '../../src/confined-executor.ts';
import type { ExecutionManifestInput } from '../../src/execution-manifest.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const launcher=required('OVERCENTER_EXEC_LAUNCHER');
const cgroupParent=required('OVERCENTER_CGROUP_PARENT');
const workspace=required('OVERCENTER_WORKSPACE');

function runtimeClosure(binary:string):Pick<ExecutionManifestInput,'runtime_read_only'|'runtime_executable'> {
  const output=execFileSync('ldd',[binary],{encoding:'utf8'});
  const dependencies=[...new Set(output.match(/\/[^\s()]+/gu) ?? [])].sort();
  return {
    runtime_read_only:fs.existsSync('/etc/ld.so.cache') ? ['/etc/ld.so.cache'] : [],
    runtime_executable:dependencies,
  };
}

function manifest(
  program:string,
  args:string[]=[],
  overrides:Partial<ExecutionManifestInput>={},
):ExecutionManifestInput {
  const stat=fs.statSync(workspace,{bigint:true});
  return {
    task_id:'resource-supervisor-proof',
    workspace,
    workspace_dev:stat.dev.toString(),
    workspace_ino:stat.ino.toString(),
    program,
    timeout_ms:5_000,
    max_output_bytes:1_048_576,
    memory_max_bytes:'134217728',
    pids_max:'16',
    cpu_quota_us:'100000',
    cpu_period_us:'100000',
    args,
    ...runtimeClosure(program),
    ...overrides,
  };
}

function leaves():string[] {
  return fs.readdirSync(cgroupParent).filter((name)=>name.startsWith('overcenter-')).sort();
}

const before=leaves();

const ordinary=await runConfinedWorker({
  launcher,
  cgroup_parent:cgroupParent,
  manifest:manifest('/bin/true'),
});
assert.equal(ordinary.exit_code,0);
assert.equal(ordinary.signal,null);
assert.ok(BigInt(ordinary.resource_usage.pids_peak)>=1n);
assert.equal(leaves().join('\n'),before.join('\n'));

await assert.rejects(
  runConfinedWorker({
    launcher,
    cgroup_parent:cgroupParent,
    manifest:manifest('/bin/echo',['TOO-LONG'],{max_output_bytes:2}),
  }),
  /WORKER_OUTPUT_LIMIT/u,
);
assert.equal(leaves().join('\n'),before.join('\n'));

await assert.rejects(
  runConfinedWorker({
    launcher,
    cgroup_parent:cgroupParent,
    manifest:manifest('/bin/sleep',['5'],{timeout_ms:50}),
  }),
  /WORKER_TIMEOUT/u,
);
assert.equal(leaves().join('\n'),before.join('\n'));

console.log('PASS: trusted supervisor cgroup containment');
