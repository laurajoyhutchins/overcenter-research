import type { ExecutionPermit } from './model.ts';
import type { Receipt } from './facts.ts';
import { GitOvercenterKernel } from './git-kernel.ts';
import {
  PROCESS_COMPUTATION_PACKET_SCHEMA,
  computationExecution,
  validateProcessComputationPacket,
  type ComputationAttemptEvidenceV1,
  type ComputationExecutionV1,
} from './computation-execution.ts';

export interface ComputationExecutor {
  execute(execution:ComputationExecutionV1):Promise<ComputationAttemptEvidenceV1>;
}

export interface ComputationStepResult {
  state:'IDLE'|'NOT_COMPUTATION'|'DONE'|'READY'|'RECOVERY_REQUIRED';
  work?:string;
  run?:string;
  intent_commit?:string;
  attempt_commit?:string;
  evidence?:ComputationAttemptEvidenceV1;
  receipt?:Receipt;
}

const errorMessage=(error:unknown)=>error instanceof Error ? error.message : String(error);

async function executeClaimedComputation(
  kernel:GitOvercenterKernel,
  executor:ComputationExecutor,
  run:ExecutionPermit,
  packet:ReturnType<typeof validateProcessComputationPacket>,
):Promise<ComputationStepResult> {
  const execution=computationExecution(run,packet.process);
  const intentCommit=kernel.prepareComputation(run,execution);

  let evidence:ComputationAttemptEvidenceV1;
  try {
    evidence=await executor.execute(execution);
  } catch (error:unknown) {
    const receipt=kernel.recoverInterrupted(run,{
      kind:'computation-executor-error',
      error:errorMessage(error),
      computation_intent_commit:intentCommit,
      may_have_mutated:false,
    });
    return {
      state:'RECOVERY_REQUIRED',
      work:run.obligation_id,
      run:run.id,
      intent_commit:intentCommit,
      receipt,
    };
  }

  const attemptCommit=kernel.recordComputationAttempt(run,execution,evidence);
  const receipt=kernel.resolve(run);
  if (receipt.disposition==='WAITING') {
    throw new Error('COMPUTATION_OBSERVATION_CANNOT_WAIT_FOR_JUDGMENT');
  }
  return {
    state:receipt.disposition,
    work:run.obligation_id,
    run:run.id,
    intent_commit:intentCommit,
    attempt_commit:attemptCommit,
    evidence,
    receipt,
  };
}

export async function runReadyComputation(
  kernel:GitOvercenterKernel,
  executor:ComputationExecutor,
):Promise<ComputationStepResult> {
  for (let attempt=0;attempt<16;attempt+=1) {
    const frontier=kernel.deriveReadyFrontier();
    if (frontier.length===0) return {state:'IDLE'};
    const work=frontier.find(
      candidate=>candidate.packet.schema===PROCESS_COMPUTATION_PACKET_SCHEMA,
    );
    if (!work) return {state:'NOT_COMPUTATION',work:frontier[0].id};
    const packet=validateProcessComputationPacket(work.packet);

    let run:ExecutionPermit;
    try {
      run=kernel.claim(work.id,work.revision);
    } catch (error:unknown) {
      const message=errorMessage(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }
    return await executeClaimedComputation(kernel,executor,run,packet);
  }
  throw new Error('COMPUTATION_CLAIM_CONTENTION_EXHAUSTED');
}
