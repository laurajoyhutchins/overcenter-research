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
  manifest:ExecutionManifestInput;
}

export interface ConfinedWorkerResult {
  manifest_sha256:string;
  exit_code:number|null;
  signal:NodeJS.Signals|null;
  stdout:string;
  stderr:string;
}

function requireAbsoluteLauncher(value:string):string {
  if (!path.isAbsolute(value)) throw new Error('LAUNCHER_NOT_ABSOLUTE');
  return value;
}

export async function runConfinedWorker(input:ConfinedWorkerLaunch):Promise<ConfinedWorkerResult> {
  const launcher=requireAbsoluteLauncher(input.launcher);
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

  return await new Promise((resolve,reject)=>{
    let child;
    try {
      child=spawn(launcher,input.launcher_args ?? [],{
        stdio:['pipe','pipe','pipe',workspaceFd],
        env:{},
        windowsHide:true,
        detached:true,
      });
    } finally {
      fs.closeSync(workspaceFd);
    }
    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];
    let outputBytes=0;
    let terminalError:Error|undefined;

    const killTree=(error:Error):void=>{
      if (terminalError) return;
      terminalError=error;
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
    child.once('error',(error)=>{ clearTimeout(timeout); reject(error); });
    child.once('close',(exitCode,signal)=>{
      clearTimeout(timeout);
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
      });
    });

    // These are the exact manifest bytes whose SHA-256 was returned above.
    // FD 3 is the already-open workspace object whose identity was checked
    // against those bytes, so Rust never needs to reopen the workspace path.
    child.stdin.end(rendered.bytes,'utf8');
  });
}
