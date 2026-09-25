import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPUTATION_EVIDENCE_SCHEMA,
  decodeProcessSpec,
  validateComputationExecution,
  type ComputationAttemptEvidence,
  type ComputationExecution,
} from '../../src/execution/protocol.ts';
import { runConfinedWorker } from './confined-executor-treatment.ts';
import type { ComputationExecutor } from '../../src/execution/runner.ts';

export interface RustComputationExecutorOptions {
  launcher:string;
  cgroupParent:string;
  workspace:string;
  executionContextSha256:string;
  memoryMaxBytes?:string;
  pidsMax?:string;
  cpuQuotaUs?:string;
  cpuPeriodUs?:string;
}

const sha256Tagged=(bytes:Uint8Array):string=>
  'sha256:'+createHash('sha256').update(bytes).digest('hex');

function runtimeClosure(program:string):string[] {
  let output:string;
  try {
    output=execFileSync('ldd',[program],{encoding:'utf8'});
  } catch {
    return [];
  }
  const paths:string[]=[];
  for (const line of output.split('\n')) {
    const arrow=/=>\s+(\/\S+)/u.exec(line)?.[1];
    const direct=/^\s*(\/\S+)\s+\(/u.exec(line)?.[1];
    const candidate=arrow??direct;
    if (!candidate) continue;
    paths.push(fs.realpathSync(candidate));
  }
  return [...new Set(paths)].filter(candidate=>fs.realpathSync(program)!==candidate).sort();
}

function captured(bytes:Buffer,maxBytes:number):{
  base64?:string;
  sha256:string;
  truncated:boolean;
} {
  const prefix=bytes.subarray(0,maxBytes);
  return {
    ...(prefix.length>0?{base64:prefix.toString('base64')}:{}),
    sha256:sha256Tagged(bytes),
    truncated:bytes.length>prefix.length,
  };
}

function emptyCapture():{
  sha256:string;
  truncated:false;
} {
  return {
    sha256:sha256Tagged(Buffer.alloc(0)),
    truncated:false,
  };
}

export class RustComputationExecutor implements ComputationExecutor {
  readonly executionContextSha256:string;
  containmentId:string|undefined;

  readonly #launcher:string;
  readonly #cgroupParent:string;
  readonly #workspace:string;
  readonly #memoryMaxBytes:string;
  readonly #pidsMax:string;
  readonly #cpuQuotaUs:string;
  readonly #cpuPeriodUs:string;

  constructor(options:RustComputationExecutorOptions) {
    this.#launcher=options.launcher;
    this.#cgroupParent=options.cgroupParent;
    this.#workspace=options.workspace;
    this.executionContextSha256=options.executionContextSha256;
    this.#memoryMaxBytes=options.memoryMaxBytes??'268435456';
    this.#pidsMax=options.pidsMax??'32';
    this.#cpuQuotaUs=options.cpuQuotaUs??'100000';
    this.#cpuPeriodUs=options.cpuPeriodUs??'100000';
  }

  async ready():Promise<void> {
    if (!path.isAbsolute(this.#launcher) || !fs.statSync(this.#launcher).isFile()) {
      throw new Error('RUST_EXECUTOR_LAUNCHER_INVALID');
    }
    if (!path.isAbsolute(this.#workspace) || !fs.statSync(this.#workspace).isDirectory()) {
      throw new Error('RUST_EXECUTOR_WORKSPACE_INVALID');
    }
    if (!path.isAbsolute(this.#cgroupParent) || !fs.statSync(this.#cgroupParent).isDirectory()) {
      throw new Error('RUST_EXECUTOR_CGROUP_PARENT_INVALID');
    }
  }

  async execute(execution:ComputationExecution):Promise<ComputationAttemptEvidence> {
    validateComputationExecution(execution);
    await this.ready();
    const spec=decodeProcessSpec(execution);
    const workspace=fs.statSync(this.#workspace,{bigint:true});
    const base={
      schema:COMPUTATION_EVIDENCE_SCHEMA,
      run_id:execution.run_id,
      obligation_id:execution.obligation_id,
      claimed_revision:execution.claimed_revision,
      execution_generation:execution.execution_generation,
      execution_authority_commit:execution.execution_authority_commit,
      execution_capability_sha256:execution.execution_capability_sha256,
      execution_spec_sha256:execution.execution_spec_sha256,
    } as const;

    try {
      const result=await runConfinedWorker({
        launcher:this.#launcher,
        cgroup_parent:this.#cgroupParent,
        on_containment:id=>{this.containmentId=id;},
        manifest:{
          task_id:`${execution.run_id}/${execution.execution_generation}`,
          workspace:this.#workspace,
          workspace_dev:workspace.dev.toString(),
          workspace_ino:workspace.ino.toString(),
          cwd:spec.cwd,
          program:spec.executable,
          timeout_ms:spec.timeout_ms,
          // The confinement supervisor keeps an independent trusted hard cap.
          // ProcessSpec capture limits are applied below to the raw streams.
          max_output_bytes:67_108_864,
          memory_max_bytes:this.#memoryMaxBytes,
          pids_max:this.#pidsMax,
          cpu_quota_us:this.#cpuQuotaUs,
          cpu_period_us:this.#cpuPeriodUs,
          args:spec.argv,
          environment:spec.env,
          runtime_executable:runtimeClosure(spec.executable),
        },
      });

      const stdout=captured(result.stdout_bytes,spec.stdout_max_bytes);
      const stderr=captured(result.stderr_bytes,spec.stderr_max_bytes);
      const failed=result.had_descendants || result.exit_code!==0 || result.signal!==null;
      return {
        ...base,
        outcome:failed?'failed':'completed',
        ...(result.exit_code===null?{}:{exit_code:result.exit_code}),
        ...(result.signal?{signal:result.signal}:{}),
        ...(stdout.base64?{stdout_base64:stdout.base64}:{}),
        stdout_sha256:stdout.sha256,
        stdout_truncated:stdout.truncated,
        ...(stderr.base64?{stderr_base64:stderr.base64}:{}),
        stderr_sha256:stderr.sha256,
        stderr_truncated:stderr.truncated,
        ...(result.had_descendants?{error:'task left background descendants after top-level exit'}:{}),
      };
    } catch (error) {
      const message=error instanceof Error?error.message:String(error);
      if (!message.includes('WORKER_TIMEOUT')) throw error;
      const stdout=emptyCapture();
      const stderr=emptyCapture();
      return {
        ...base,
        outcome:'cancelled',
        stdout_sha256:stdout.sha256,
        stdout_truncated:stdout.truncated,
        stderr_sha256:stderr.sha256,
        stderr_truncated:stderr.truncated,
        error:message,
      };
    }
  }
}
