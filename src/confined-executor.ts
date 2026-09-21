import { spawn } from 'node:child_process';
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
  resource_usage:ConfinedWorkerResourceUsage|null;
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
  const cgroupFd=fs.openSync(
    cgroupParent,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const workspaceStat=fs.fstatSync(workspaceFd,{bigint:true});
  if (
    workspaceStat.dev.toString()!==input.manifest.workspace_dev
    || workspaceStat.ino.toString()!==input.manifest.workspace_ino
  ) {
    fs.closeSync(workspaceFd);
    fs.closeSync(cgroupFd);
    throw new Error('WORKSPACE_IDENTITY_CHANGED');
  }

  return await new Promise((resolve,reject)=>{
    let child;
    try {
      child=spawn(launcher,input.launcher_args ?? [],{
        stdio:['pipe','pipe','pipe',workspaceFd,cgroupFd],
        env:{},
        windowsHide:true,
        detached:true,
      });
    } catch (error) {
      fs.closeSync(cgroupFd);
      throw error;
    } finally {
      fs.closeSync(workspaceFd);
    }
    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];
    let outputBytes=0;
    let terminalError:Error|undefined;
    let transportClosed=false;
    const cgroupName=child.pid ? `overcenter-${child.pid}` : undefined;
    const cgroupPath=cgroupName ? `/proc/self/fd/${cgroupFd}/${cgroupName}` : undefined;

    const killCgroup=():void=>{
      if (!cgroupPath) return;
      try { fs.writeFileSync(path.join(cgroupPath,'cgroup.kill'),'1'); } catch {}
    };

    const collectResourceUsage=():ConfinedWorkerResourceUsage|null=>{
      if (!cgroupPath || !cgroupName || !fs.existsSync(cgroupPath)) return null;
      const memoryEvents=fs.readFileSync(path.join(cgroupPath,'memory.events'),'utf8');
      const pidsEvents=fs.readFileSync(path.join(cgroupPath,'pids.events'),'utf8');
      const cpuStat=fs.readFileSync(path.join(cgroupPath,'cpu.stat'),'utf8');
      return {
        cgroup:cgroupName,
        memory_peak_bytes:fs.readFileSync(path.join(cgroupPath,'memory.peak'),'utf8').trim(),
        memory_oom_kills:keyedValue(memoryEvents,'oom_kill'),
        pids_peak:fs.readFileSync(path.join(cgroupPath,'pids.peak'),'utf8').trim(),
        pids_max_events:keyedValue(pidsEvents,'max'),
        cpu_usage_usec:keyedValue(cpuStat,'usage_usec'),
        cpu_nr_throttled:keyedValue(cpuStat,'nr_throttled'),
        cpu_throttled_usec:keyedValue(cpuStat,'throttled_usec'),
      };
    };

    const cleanupCgroup=async():Promise<ConfinedWorkerResourceUsage|null>=>{
      let usage:ConfinedWorkerResourceUsage|null=null;
      let evidenceError:unknown;
      try {
        usage=collectResourceUsage();
      } catch (error) {
        evidenceError=error;
      }

      if (cgroupPath && fs.existsSync(cgroupPath)) {
        killCgroup();
        let removed=false;
        for (let attempt=0;attempt<50;attempt+=1) {
          try {
            fs.rmdirSync(cgroupPath);
            removed=true;
            break;
          } catch (error) {
            if (
              !(error instanceof Error)
              || !('code' in error)
              || !['EBUSY','ENOTEMPTY'].includes(String(error.code))
            ) throw error;
            await sleep(10);
          }
        }
        if (!removed) throw new Error('WORKER_CGROUP_CLEANUP');
      }

      if (evidenceError) throw evidenceError;
      return usage;
    };

    const killTree=(error:Error):void=>{
      if (terminalError) return;
      terminalError=error;
      killCgroup();
      if (child.pid) {
        try { process.kill(-child.pid,'SIGKILL'); } catch {}
      }
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
      fs.closeSync(cgroupFd);
      reject(error);
    });
    child.once('close',(exitCode,signal)=>{
      if (transportClosed) return;
      transportClosed=true;
      clearTimeout(timeout);
      void (async()=>{
        try {
          const resourceUsage=await cleanupCgroup();
          fs.closeSync(cgroupFd);
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
          try { fs.closeSync(cgroupFd); } catch {}
          reject(error);
        }
      })();
    });

    // These are the exact manifest bytes whose SHA-256 was returned above.
    // FD 3 is the already-open workspace object. FD 4 is the trusted delegated
    // cgroup parent. Rust consumes both before close_range removes them.
    child.stdin.end(rendered.bytes,'utf8');
  });
}
