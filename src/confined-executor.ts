import { spawn } from 'node:child_process';
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

  return await new Promise((resolve,reject)=>{
    const child=spawn(launcher,input.launcher_args ?? [],{
      stdio:['pipe','pipe','pipe'],
      env:{},
      windowsHide:true,
    });
    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];

    child.stdout.on('data',(chunk:Buffer)=>stdout.push(Buffer.from(chunk)));
    child.stderr.on('data',(chunk:Buffer)=>stderr.push(Buffer.from(chunk)));
    child.once('error',reject);
    child.once('close',(exitCode,signal)=>{
      resolve({
        manifest_sha256:rendered.sha256,
        exit_code:exitCode,
        signal,
        stdout:Buffer.concat(stdout).toString('utf8'),
        stderr:Buffer.concat(stderr).toString('utf8'),
      });
    });

    // These are the exact bytes whose SHA-256 was returned above. The Rust
    // launcher parses them before it creates the worker process, so there is no
    // manifest pathname for an untrusted worker to swap.
    child.stdin.end(rendered.bytes,'utf8');
  });
}
