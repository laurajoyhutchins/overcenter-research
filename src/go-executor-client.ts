import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import {
  EXECUTOR_COMMAND_SCHEMA,
  assertComputationEvidenceFor,
  executionIdentity,
  executionIdentityKey,
  validateComputationEvidence,
  validateExecutorHello,
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
  socketPath:string;
  maxConcurrency:number;
  executionContextSha256?:string;
  containmentId?:string;
}

export class GoExecutorClient {
  executionContextSha256?:string;
  containmentId?:string;
  readonly #expectedExecutionContextSha256?:string;
  readonly #expectedContainmentId?:string;
  readonly #helloRequired:boolean;
  #helloSeen=false;
  readonly #ready:Promise<void>;
  #resolveReady!:()=>void;
  #rejectReady!:(error:Error)=>void;
  readonly #socket:Socket;
  readonly #maxConcurrency:number;
  readonly #pending=new Map<string,PendingExecution>();
  readonly #capacityWaiters:Array<()=>void>=[];
  readonly #connected:Promise<void>;
  readonly #closed:Promise<void>;
  #inflight=0;
  #terminalError:Error|null=null;
  #closing=false;

  constructor({
    socketPath,
    maxConcurrency,
    executionContextSha256,
    containmentId,
  }:GoExecutorClientOptions) {
    if (!socketPath.startsWith('/')) {
      throw new Error('GO_EXECUTOR_SOCKET_MUST_BE_ABSOLUTE');
    }
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency<=0) {
      throw new Error('GO_EXECUTOR_CONCURRENCY_INVALID');
    }
    if (
      executionContextSha256!==undefined
      && !/^sha256:[0-9a-f]{64}$/.test(executionContextSha256)
    ) {
      throw new Error('GO_EXECUTOR_EXECUTION_CONTEXT_INVALID');
    }
    if (
      containmentId!==undefined
      && (containmentId.length===0 || containmentId.length>512 || containmentId.includes('\0'))
    ) {
      throw new Error('GO_EXECUTOR_CONTAINMENT_ID_INVALID');
    }
    if ((executionContextSha256===undefined)!==(containmentId===undefined)) {
      throw new Error('GO_EXECUTOR_ATTESTATION_PAIR_REQUIRED');
    }
    this.#expectedExecutionContextSha256=executionContextSha256;
    this.#expectedContainmentId=containmentId;
    this.#helloRequired=executionContextSha256!==undefined;
    this.#ready=new Promise<void>((resolve,reject)=>{
      this.#resolveReady=resolve;
      this.#rejectReady=reject;
    });
    void this.#ready.catch(()=>{});
    this.#maxConcurrency=maxConcurrency;
    this.#socket=createConnection({path:socketPath});

    this.#connected=new Promise((resolve,reject)=>{
      this.#socket.once('connect',()=>{
        resolve();
        if (!this.#helloRequired) this.#resolveReady();
      });
      this.#socket.once('error',reject);
    });

    const lines=createInterface({input:this.#socket,crlfDelay:Infinity});
    lines.on('line',line=>{
      try {
        const parsed:unknown=JSON.parse(line);
        if (this.#helloRequired && !this.#helloSeen) {
          const hello=validateExecutorHello(parsed);
          if (
            hello.execution_context_sha256!==this.#expectedExecutionContextSha256
            || hello.containment_id!==this.#expectedContainmentId
          ) {
            throw new Error('GO_EXECUTOR_ATTESTATION_MISMATCH');
          }
          this.#helloSeen=true;
          this.executionContextSha256=hello.execution_context_sha256;
          this.containmentId=hello.containment_id;
          this.#resolveReady();
          return;
        }
        const evidence=validateComputationEvidence(parsed);
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

    this.#socket.on('error',error=>this.#fail(error));
    this.#closed=new Promise(resolve=>{
      this.#socket.once('close',hadError=>{
        if (hadError) {
          this.#fail(new Error('GO_EXECUTOR_SOCKET_CLOSED_WITH_ERROR'));
        } else if (this.#pending.size>0) {
          this.#fail(new Error('GO_EXECUTOR_SOCKET_CLOSED_WITH_PENDING_EXECUTIONS'));
        } else if (!this.#closing) {
          this.#fail(new Error('GO_EXECUTOR_SOCKET_CLOSED'));
        }
        resolve();
      });
    });
  }

  async ready():Promise<void> {
    await this.#connected;
    await this.#ready;
    if (this.#terminalError) throw this.#terminalError;
  }

  async execute(execution:ComputationExecutionV1):Promise<ComputationAttemptEvidenceV1> {
    validateComputationExecution(execution);
    await this.ready();
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
    await this.ready();
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
    await this.ready();
    this.#closing=true;
    this.#socket.end();
    await this.#closed;
    if (this.#terminalError) throw this.#terminalError;
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
    if (this.#socket.write(line)) return;
    await Promise.race([
      once(this.#socket,'drain'),
      this.#closed,
    ]);
    if (this.#terminalError) throw this.#terminalError;
    if (this.#socket.destroyed) throw new Error('GO_EXECUTOR_SOCKET_CLOSED');
  }

  #fail(error:Error):void {
    if (this.#terminalError) return;
    this.#terminalError=error;
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
      this.#releaseCapacity();
    }
    this.#pending.clear();
    for (const wake of this.#capacityWaiters.splice(0)) wake();
    if (!this.#socket.destroyed) this.#socket.destroy();
  }
}
