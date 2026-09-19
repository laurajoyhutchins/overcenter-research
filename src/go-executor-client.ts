import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  EXECUTOR_COMMAND_SCHEMA,
  assertComputationEvidenceFor,
  executionIdentity,
  executionIdentityKey,
  validateComputationEvidence,
  validateComputationExecution,
  type ComputationAttemptEvidenceV1,
  type ComputationExecutionV1,
  type ExecutorCommandV1,
} from './computation-execution.ts';

interface PendingExecution {
  execution:ComputationExecutionV1;
  resolve:(evidence:ComputationAttemptEvidenceV1)=>void;
  reject:(error:Error)=>void;
}

export interface GoExecutorClientOptions {
  binaryPath:string;
  workspaceRoot:string;
  maxConcurrency:number;
}

export class GoExecutorClient {
  readonly #child:ChildProcessWithoutNullStreams;
  readonly #maxConcurrency:number;
  readonly #pending=new Map<string,PendingExecution>();
  readonly #capacityWaiters:Array<()=>void>=[];
  readonly #closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>;
  #inflight=0;
  #terminalError:Error|null=null;
  #stderr='';

  constructor({
    binaryPath,
    workspaceRoot,
    maxConcurrency,
  }:GoExecutorClientOptions) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency<=0) {
      throw new Error('GO_EXECUTOR_CONCURRENCY_INVALID');
    }
    this.#maxConcurrency=maxConcurrency;
    this.#child=spawn(
      binaryPath,
      [
        `--workspace-root=${workspaceRoot}`,
        `--concurrency=${maxConcurrency}`,
      ],
      {
        stdio:['pipe','pipe','pipe'],
        env:{},
      },
    );

    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data',chunk=>{
      this.#stderr=(this.#stderr+String(chunk)).slice(-16*1024);
    });

    const lines=createInterface({input:this.#child.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{
      try {
        const evidence=validateComputationEvidence(JSON.parse(line));
        const key=executionIdentityKey({
          run_id:evidence.run_id,
          execution_generation:evidence.execution_generation,
          execution_authority_commit:evidence.execution_authority_commit,
        });
        const pending=this.#pending.get(key);
        if (!pending) {
          throw new Error(`GO_EXECUTOR_UNEXPECTED_EVIDENCE:${key}`);
        }
        assertComputationEvidenceFor(evidence,pending.execution);
        this.#pending.delete(key);
        this.#releaseCapacity();
        pending.resolve(evidence);
      } catch (error) {
        this.#fail(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    });

    this.#closed=new Promise(resolve=>{
      this.#child.once('close',(code,signal)=>{
        const result={code,signal};
        if (code!==0 || signal!==null) {
          this.#fail(new Error(
            `GO_EXECUTOR_EXITED:code=${String(code)}:signal=${String(signal)}:stderr=${this.#stderr}`,
          ));
        } else if (this.#pending.size>0) {
          this.#fail(new Error('GO_EXECUTOR_EXITED_WITH_PENDING_EXECUTIONS'));
        }
        resolve(result);
      });
    });

    this.#child.once('error',error=>this.#fail(error));
  }

  async execute(execution:ComputationExecutionV1):Promise<ComputationAttemptEvidenceV1> {
    validateComputationExecution(execution);
    await this.#acquireCapacity();
    if (this.#terminalError) {
      this.#releaseCapacity();
      throw this.#terminalError;
    }

    const key=executionIdentityKey(executionIdentity(execution));
    if (this.#pending.has(key)) {
      this.#releaseCapacity();
      throw new Error(`GO_EXECUTOR_DUPLICATE_EXECUTION:${key}`);
    }

    let resolve!:PendingExecution['resolve'];
    let reject!:PendingExecution['reject'];
    const evidencePromise=new Promise<ComputationAttemptEvidenceV1>((res,rej)=>{
      resolve=res;
      reject=rej;
    });
    this.#pending.set(key,{execution,resolve,reject});

    const command:ExecutorCommandV1={
      schema:EXECUTOR_COMMAND_SCHEMA,
      kind:'execute',
      execution,
    };
    try {
      await this.#writeCommand(command);
    } catch (error) {
      this.#pending.delete(key);
      this.#releaseCapacity();
      throw error;
    }
    return await evidencePromise;
  }

  async cancel(execution:ComputationExecutionV1):Promise<void> {
    validateComputationExecution(execution);
    const command:ExecutorCommandV1={
      schema:EXECUTOR_COMMAND_SCHEMA,
      kind:'cancel',
      identity:executionIdentity(execution),
    };
    await this.#writeCommand(command);
  }

  async close():Promise<void> {
    if (this.#pending.size>0) {
      throw new Error('GO_EXECUTOR_CLOSE_WITH_PENDING_EXECUTIONS');
    }
    this.#child.stdin.end();
    const {code,signal}=await this.#closed;
    if (code!==0 || signal!==null) {
      throw this.#terminalError??new Error('GO_EXECUTOR_CLOSE_FAILED');
    }
  }

  async #acquireCapacity():Promise<void> {
    if (this.#inflight<this.#maxConcurrency) {
      this.#inflight+=1;
      return;
    }
    await new Promise<void>(resolve=>this.#capacityWaiters.push(resolve));
    this.#inflight+=1;
  }

  #releaseCapacity():void {
    if (this.#inflight>0) this.#inflight-=1;
    this.#capacityWaiters.shift()?.();
  }

  async #writeCommand(command:ExecutorCommandV1):Promise<void> {
    if (this.#terminalError) throw this.#terminalError;
    const line=JSON.stringify(command)+'\n';
    if (this.#child.stdin.write(line)) return;
    await once(this.#child.stdin,'drain');
    if (this.#terminalError) throw this.#terminalError;
  }

  #fail(error:Error):void {
    if (this.#terminalError) return;
    this.#terminalError=error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
      this.#releaseCapacity();
    }
    this.#pending.clear();
    for (const wake of this.#capacityWaiters.splice(0)) wake();
    if (!this.#child.killed) this.#child.kill('SIGKILL');
  }
}
