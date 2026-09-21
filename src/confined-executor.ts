import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  renderExecutionManifest,
  type ExecutionManifestInput,
  type RenderedExecutionManifest,
} from './execution-manifest.ts';

export interface ConfinedWorkerLaunch {
  launcher:string;
  launcher_args?:string[];
  cgroup_parent:string;
  manifest:ExecutionManifestInput;
}

export interface ConfinedWorkerResourceUsage {
  cgroup:string;
  memory_peak_bytes:string;
  memory_oom_kills:string;
  pids_peak:string;
  pids_max_events:string;
  cpu_usage_usec:string;
  cpu_nr_throttled:string;
  cpu_throttled_usec:string;
}

export interface ConfinedWorkerResult {
  manifest_sha256:string;
  exit_code:number|null;
  signal:NodeJS.Signals|null;
  stdout:string;
  stderr:string;
  resource_usage:ConfinedWorkerResourceUsage;
}

interface CgroupLeaf {
  name:string;
  parent_fd:number;
  leaf_fd:number;
  entry_path:string;
  dev:bigint;
  ino:bigint;
}

function requireAbsoluteLauncher(value:string):string {
  if (!path.isAbsolute(value)) throw new Error('LAUNCHER_NOT_ABSOLUTE');
  return value;
}

function requireAbsoluteCgroupParent(value:string):string {
  if (!path.isAbsolute(value)) throw new Error('CGROUP_PARENT_NOT_ABSOLUTE');
  return value;
}

const sleep=(milliseconds:number):Promise<void>=>new Promise((resolve)=>setTimeout(resolve,milliseconds));

function keyedValue(content:string,key:string):string {
  const line=content.split('\n').find((candidate)=>candidate.startsWith(`${key} `));
  if (!line) throw new Error(`CGROUP_EVIDENCE_MISSING_${key.toUpperCase()}`);
  return line.slice(key.length+1).trim();
}

function counter(content:string,name:string):string {
  const value=content.trim();
  if (!/^[0-9]+$/u.test(value)) throw new Error(`CGROUP_EVIDENCE_INVALID_${name}`);
  return value;
}

function requireFiniteParentEnvelope(parentFd:number):void {
  const parentPath=`/proc/self/fd/${parentFd}`;
  const cgroupType=fs.readFileSync(path.join(parentPath,'cgroup.type'),'utf8').trim();
  if (cgroupType!=='domain') throw new Error('CGROUP_PARENT_NOT_DOMAIN');

  const enabled=new Set(
    fs.readFileSync(path.join(parentPath,'cgroup.subtree_control'),'utf8')
      .trim()
      .split(/\s+/u)
      .filter(Boolean),
  );
  for (const controller of ['cpu','memory','pids']) {
    if (!enabled.has(controller)) throw new Error(`CGROUP_PARENT_CONTROLLER_MISSING_${controller.toUpperCase()}`);
  }

  const finite=(file:string):string=>{
    const value=fs.readFileSync(path.join(parentPath,file),'utf8').trim();
    if (!/^[0-9]+$/u.test(value) || value==='0') {
      throw new Error(`CGROUP_PARENT_UNBOUNDED_${file.toUpperCase().replaceAll('.','_')}`);
    }
    return value;
  };
  finite('memory.max');
  finite('pids.max');

  const [quota,period,...extra]=fs.readFileSync(path.join(parentPath,'cpu.max'),'utf8').trim().split(/\s+/u);
  if (extra.length!==0 || !quota || !period || !/^[0-9]+$/u.test(quota) || !/^[0-9]+$/u.test(period)) {
    throw new Error('CGROUP_PARENT_UNBOUNDED_CPU_MAX');
  }
}

function createCgroupLeaf(cgroupParent:string):CgroupLeaf {
  const parentFd=fs.openSync(
    cgroupParent,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    requireFiniteParentEnvelope(parentFd);
  } catch (error) {
    fs.closeSync(parentFd);
    throw error;
  }
  for (let attempt=0;attempt<8;attempt+=1) {
    const name=`overcenter-${randomBytes(16).toString('hex')}`;
    const entryPath=`/proc/self/fd/${parentFd}/${name}`;
    try {
      fs.mkdirSync(entryPath,{mode:0o700});
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code==='EEXIST') continue;
      fs.closeSync(parentFd);
      throw error;
    }

    try {
      const leafFd=fs.openSync(
        entryPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      const stat=fs.fstatSync(leafFd,{bigint:true});
      return {name,parent_fd:parentFd,leaf_fd:leafFd,entry_path:entryPath,dev:stat.dev,ino:stat.ino};
    } catch (error) {
      try { fs.rmdirSync(entryPath); } catch {}
      fs.closeSync(parentFd);
      throw error;
    }
  }
  fs.closeSync(parentFd);
  throw new Error('CGROUP_LEAF_NAME_EXHAUSTED');
}

function removeUnstartedLeaf(leaf:CgroupLeaf):void {
  try { fs.closeSync(leaf.leaf_fd); } catch {}
  try { fs.rmdirSync(leaf.entry_path); } catch {}
  try { fs.closeSync(leaf.parent_fd); } catch {}
}

export async function runConfinedWorker(input:ConfinedWorkerLaunch):Promise<ConfinedWorkerResult> {
  const launcher=requireAbsoluteLauncher(input.launcher);
  const cgroupParent=requireAbsoluteCgroupParent(input.cgroup_parent);
  const rendered:RenderedExecutionManifest=renderExecutionManifest(input.manifest);
  const timeoutMs=rendered.timeout_ms;
  const maxOutputBytes=rendered.max_output_bytes;

  const workspaceFd=fs.openSync(
    input.manifest.workspace,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const workspaceStat=fs.fstatSync(workspaceFd,{bigint:true});
  if (
    workspaceStat.dev.toString()!==input.manifest.workspace_dev
    || workspaceStat.ino.toString()!==input.manifest.workspace_ino
  ) {
    fs.closeSync(workspaceFd);
    throw new Error('WORKSPACE_IDENTITY_CHANGED');
  }

  let leaf:CgroupLeaf;
  try {
    leaf=createCgroupLeaf(cgroupParent);
  } catch (error) {
    fs.closeSync(workspaceFd);
    throw error;
  }

  return await new Promise((resolve,reject)=>{
    let child;
    try {
      child=spawn(launcher,input.launcher_args ?? [],{
        stdio:['pipe','pipe','pipe',workspaceFd,leaf.leaf_fd],
        env:{},
        windowsHide:true,
        detached:true,
      });
    } catch (error) {
      removeUnstartedLeaf(leaf);
      throw error;
    } finally {
      fs.closeSync(workspaceFd);
    }

    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];
    let outputBytes=0;
    let terminalError:Error|undefined;
    let transportClosed=false;
    const leafPath=`/proc/self/fd/${leaf.leaf_fd}`;

    const processGroupKill=():void=>{
      if (child.pid) {
        try { process.kill(-child.pid,'SIGKILL'); } catch {}
      }
    };

    const killCgroup=(strict:boolean):void=>{
      const killPath=path.join(leafPath,'cgroup.kill');
      if (!fs.existsSync(killPath)) {
        if (strict) throw new Error('CGROUP_KILL_MISSING');
        return;
      }
      try {
        fs.writeFileSync(killPath,'1');
      } catch (error) {
        if (strict) throw error;
      }
    };

    const waitCgroupEmpty=async():Promise<void>=>{
      for (let attempt=0;attempt<100;attempt+=1) {
        const events=fs.readFileSync(path.join(leafPath,'cgroup.events'),'utf8');
        if (keyedValue(events,'populated')==='0') return;
        await sleep(10);
      }
      throw new Error('WORKER_CGROUP_STILL_POPULATED');
    };

    const exact=(file:string,expected:string):void=>{
      const observed=fs.readFileSync(path.join(leafPath,file),'utf8').trim();
      if (observed!==expected) {
        throw new Error(`CGROUP_POLICY_MISMATCH_${file.toUpperCase().replaceAll('.','_')}`);
      }
    };

    const collectResourceUsage=():ConfinedWorkerResourceUsage=>{
      exact('memory.max',rendered.memory_max_bytes);
      exact('memory.swap.max','0');
      exact('memory.oom.group','1');
      exact('pids.max',rendered.pids_max);
      exact('cpu.max',`${rendered.cpu_quota_us} ${rendered.cpu_period_us}`);

      const memoryEvents=fs.readFileSync(path.join(leafPath,'memory.events'),'utf8');
      const pidsEvents=fs.readFileSync(path.join(leafPath,'pids.events'),'utf8');
      const cpuStat=fs.readFileSync(path.join(leafPath,'cpu.stat'),'utf8');
      const pidsPeak=counter(fs.readFileSync(path.join(leafPath,'pids.peak'),'utf8'),'PIDS_PEAK');
      if (BigInt(pidsPeak)<1n) throw new Error('CGROUP_NEVER_POPULATED');

      return {
        cgroup:leaf.name,
        memory_peak_bytes:counter(
          fs.readFileSync(path.join(leafPath,'memory.peak'),'utf8'),
          'MEMORY_PEAK',
        ),
        memory_oom_kills:counter(keyedValue(memoryEvents,'oom_kill'),'MEMORY_OOM_KILLS'),
        pids_peak:pidsPeak,
        pids_max_events:counter(keyedValue(pidsEvents,'max'),'PIDS_MAX_EVENTS'),
        cpu_usage_usec:counter(keyedValue(cpuStat,'usage_usec'),'CPU_USAGE_USEC'),
        cpu_nr_throttled:counter(keyedValue(cpuStat,'nr_throttled'),'CPU_NR_THROTTLED'),
        cpu_throttled_usec:counter(keyedValue(cpuStat,'throttled_usec'),'CPU_THROTTLED_USEC'),
      };
    };

    const removeExactLeaf=async():Promise<void>=>{
      const entryStat=fs.statSync(leaf.entry_path,{bigint:true});
      if (entryStat.dev!==leaf.dev || entryStat.ino!==leaf.ino) {
        throw new Error('WORKER_CGROUP_IDENTITY_CHANGED');
      }
      for (let attempt=0;attempt<50;attempt+=1) {
        try {
          fs.rmdirSync(leaf.entry_path);
          return;
        } catch (error) {
          if (
            !(error instanceof Error)
            || !('code' in error)
            || !['EBUSY','ENOTEMPTY'].includes(String(error.code))
          ) throw error;
          await sleep(10);
        }
      }
      throw new Error('WORKER_CGROUP_CLEANUP');
    };

    const cleanupCgroup=async():Promise<ConfinedWorkerResourceUsage>=>{
      let containmentError:unknown;
      try {
        killCgroup(true);
        await waitCgroupEmpty();
      } catch (error) {
        containmentError=error;
        processGroupKill();
        try { await waitCgroupEmpty(); } catch {}
      }

      let usage:ConfinedWorkerResourceUsage|undefined;
      let evidenceError:unknown;
      try {
        usage=collectResourceUsage();
      } catch (error) {
        evidenceError=error;
      }

      let cleanupError:unknown;
      try {
        await removeExactLeaf();
      } catch (error) {
        cleanupError=error;
      } finally {
        try { fs.closeSync(leaf.leaf_fd); } catch {}
        try { fs.closeSync(leaf.parent_fd); } catch {}
      }

      if (containmentError) throw containmentError;
      if (cleanupError) throw cleanupError;
      if (evidenceError) throw evidenceError;
      if (!usage) throw new Error('CGROUP_EVIDENCE_MISSING');
      return usage;
    };

    const killTree=(error:Error):void=>{
      if (terminalError) return;
      terminalError=error;
      killCgroup(false);
      processGroupKill();
    };

    const capture=(target:Buffer[])=>(chunk:Buffer):void=>{
      outputBytes+=chunk.length;
      if (outputBytes>maxOutputBytes) {
        killTree(new Error('WORKER_OUTPUT_LIMIT'));
        return;
      }
      target.push(Buffer.from(chunk));
    };

    const timeout=setTimeout(()=>killTree(new Error('WORKER_TIMEOUT')),timeoutMs);
    timeout.unref();

    child.stdout.on('data',capture(stdout));
    child.stderr.on('data',capture(stderr));
    child.stdin.on('error',(error)=>{
      if (!terminalError) killTree(new Error(`WORKER_STDIN: ${error.message}`));
    });
    child.once('error',(error)=>{
      if (transportClosed) return;
      transportClosed=true;
      clearTimeout(timeout);
      void (async()=>{
        try { await cleanupCgroup(); } catch {}
        reject(error);
      })();
    });
    child.once('close',(exitCode,signal)=>{
      if (transportClosed) return;
      transportClosed=true;
      clearTimeout(timeout);
      void (async()=>{
        try {
          const resourceUsage=await cleanupCgroup();
          if (terminalError) {
            reject(terminalError);
            return;
          }
          resolve({
            manifest_sha256:rendered.sha256,
            exit_code:exitCode,
            signal,
            stdout:Buffer.concat(stdout).toString('utf8'),
            stderr:Buffer.concat(stderr).toString('utf8'),
            resource_usage:resourceUsage,
          });
        } catch (error) {
          reject(error);
        }
      })();
    });

    // These are the exact manifest bytes whose SHA-256 was returned above.
    // FD 3 is the already-open workspace object. FD 4 is the exact host-created
    // cgroup leaf. Rust consumes both before close_range removes them.
    child.stdin.end(rendered.bytes,'utf8');
  });
}
