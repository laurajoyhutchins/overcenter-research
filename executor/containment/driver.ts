import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function option(name) {
  const index=process.argv.indexOf(name);
  const value=index<0 ? undefined : process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(name+' requires a value');
  return value;
}

const concurrency=option('--concurrency');
const taskUid=option('--task-uid');
const taskGid=option('--task-gid');

const workspace='/workspace';
const capability='containment-capability';
const spec={
  schema:'overcenter-process-spec-v1',
  executable:process.execPath,
  argv:['--experimental-strip-types','/fixture.ts','tree-detached-ignore-term','',workspace+'/tree.pid'],
  cwd:'.',
  env:{},
  timeout_ms:60000,
  stdout_max_bytes:1024,
  stderr_max_bytes:1024,
};
const specBytes=Buffer.from(JSON.stringify(spec));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const execution={
  schema:'overcenter-computation-execution-v1',
  run_id:'containment-run',
  obligation_id:'containment-obligation',
  claimed_revision:'containment-revision',
  execution_generation:1,
  execution_authority_commit:'containment-authority',
  execution_capability:capability,
  execution_capability_sha256:sha256(capability),
  execution_spec_base64:specBytes.toString('base64'),
  execution_spec_sha256:'sha256:'+sha256(specBytes),
};
const command={
  schema:'overcenter-executor-command-v1',
  kind:'execute',
  execution,
};

const executor=spawn(
  '/usr/local/bin/overcenter-executor',
  [
    '--stdio',
    '--workspace-root='+workspace,
    '--concurrency='+concurrency,
    '--task-uid='+taskUid,
    '--task-gid='+taskGid,
  ],
  {stdio:['pipe','ignore','inherit'],env:{}},
);
executor.stdin.write(JSON.stringify(command)+'\n');

const deadline=Date.now()+10000;
while (Date.now()<deadline) {
  if (existsSync(workspace+'/tree.pid')) {
    const records=readFileSync(workspace+'/tree.pid','utf8').trim().split('\n').filter(Boolean);
    if (records.length>=2) break;
  }
  await new Promise(resolve=>setTimeout(resolve,25));
}
if (!existsSync(workspace+'/tree.pid')) {
  throw new Error('hostile process tree never started');
}
const records=readFileSync(workspace+'/tree.pid','utf8').trim().split('\n').filter(Boolean);
if (records.length<2) throw new Error('grandchild never started');

const parentPid=Number.parseInt(records.find(record=>record.startsWith('parent:'))?.split(':')[1]??'',10);
if (!Number.isSafeInteger(parentPid)) throw new Error('parent pid missing');
const statusOf=pid=>readFileSync('/proc/'+pid+'/status','utf8');
const uidOf=pid=>{
  const match=statusOf(pid).match(/^Uid:\s+(\d+)/m);
  if (!match) throw new Error('uid unavailable for pid '+pid);
  return Number.parseInt(match[1],10);
};
const groupsOf=pid=>{
  const match=statusOf(pid).match(/^Groups:\s*(.*)$/m);
  if (!match) throw new Error('groups unavailable for pid '+pid);
  return match[1].trim().split(/\s+/).filter(Boolean).map(value=>Number.parseInt(value,10));
};
if (uidOf(executor.pid)!==0) throw new Error('executor is not root inside containment worker');
if (uidOf(parentPid)!==Number.parseInt(taskUid,10)) throw new Error('task did not drop to configured uid');
const taskGroups=groupsOf(parentPid);
if (taskGroups.length!==1 || taskGroups[0]!==Number.parseInt(taskGid,10)) {
  throw new Error('task supplementary groups not confined: '+JSON.stringify(taskGroups));
}

writeFileSync(workspace+'/credential-proof',`executor=0 task=${taskUid} groups=${taskGid}\n`);
writeFileSync(workspace+'/ready','ready\n');
executor.kill('SIGKILL');
await new Promise(resolve=>executor.once('close',resolve));
writeFileSync(workspace+'/executor-killed','executor killed\n');

// Keep the worker container alive. The hostile grandchild is intentionally
// outside any cleanup the dead executor can now perform. The host must destroy
// this disposable worker environment.
setInterval(()=>{},1000);
