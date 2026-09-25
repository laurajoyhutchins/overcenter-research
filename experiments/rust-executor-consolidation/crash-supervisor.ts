import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { runConfinedWorker } from './confined-executor-treatment.ts';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{
  const [key,...rest]=value.replace(/^--/u,'').split('=');
  return [key,rest.join('=')];
}));
const launcher=args.launcher;
const cgroupParent=args.cgroup;
const workspace=args.workspace;
if (!launcher || !cgroupParent || !workspace) {
  throw new Error('usage: crash-supervisor.ts --launcher=... --cgroup=... --workspace=...');
}

const program='/usr/bin/sleep';

function runtimeClosure(executable:string):string[] {
  let output:string;
  try {
    output=execFileSync('ldd',[executable],{encoding:'utf8'});
  } catch {
    return [];
  }
  const paths:string[]=[];
  for (const line of output.split('\n')) {
    const arrow=/=>\s+(\/\S+)/u.exec(line)?.[1];
    const direct=/^\s*(\/\S+)\s+\(/u.exec(line)?.[1];
    const candidate=arrow??direct;
    if (candidate) paths.push(fs.realpathSync(candidate));
  }
  return [...new Set(paths)].filter(candidate=>fs.realpathSync(executable)!==candidate).sort();
}

const stat=fs.statSync(workspace,{bigint:true});
await runConfinedWorker({
  launcher,
  cgroup_parent:cgroupParent,
  on_containment:id=>{
    process.stdout.write(JSON.stringify({containment_id:id})+'\n');
  },
  manifest:{
    task_id:'catastrophic-recovery-proof',
    workspace,
    workspace_dev:stat.dev.toString(),
    workspace_ino:stat.ino.toString(),
    cwd:'.',
    program,
    timeout_ms:60_000,
    max_output_bytes:1024,
    memory_max_bytes:'134217728',
    pids_max:'8',
    cpu_quota_us:'100000',
    cpu_period_us:'100000',
    args:['60'],
    environment:{},
    runtime_executable:runtimeClosure(program),
  },
});
