import type {
  Data,
  ExecutionPermit,
  Work,
} from './model.ts';
import {
  COMPUTATION_EVIDENCE_SCHEMA,
  assertComputationEvidenceFor,
  computationExecution,
  validateProcessSpec,
  type ComputationAttemptEvidenceV1,
  type ComputationExecutionV1,
  type ProcessSpecV1,
} from './computation-execution.ts';
import {
  KernelCore,
  type Receipt,
} from './kernel-core.ts';

export const REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA='overcenter-replay-safe-test-computation-v1' as const;
export const COMPUTATION_ATTEMPT_SUMMARY_SCHEMA='overcenter-computation-attempt-summary-v1' as const;
export const COMPUTATION_TRANSPORT_FAILURE_SCHEMA='overcenter-computation-transport-failure-v1' as const;

export interface ReplaySafeTestComputationPacketV1 {
  schema:typeof REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA;
  kind:'test';
  execution_context_sha256:string;
  process_spec:ProcessSpecV1;
}

export type TestComputationPacket=ReplaySafeTestComputationPacketV1;

export interface ComputationExecutor {
  readonly executionContextSha256?:string;
  readonly containmentId?:string;
  ready?():Promise<void>;
  execute(
    execution:ComputationExecutionV1,
  ):Promise<ComputationAttemptEvidenceV1>;
}

export interface TestComputationResult {
  state:'DONE'|'READY'|'RECOVERY_REQUIRED';
  work_id:string;
  run_id:string;
  execution_generation:number;
  execution_spec_sha256:string;
  receipt:Receipt;
  evidence?:ComputationAttemptEvidenceV1;
  transport_error?:string;
}

export interface ComputationRecoveryAuthority {
  assertTerminated(containmentId:string):Promise<void>;
}

function errorMessage(error:unknown):string {
  const message=error instanceof Error ? error.message : String(error);
  return message.length<=2048 ? message : message.slice(0,2048);
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

export function validateTestComputationPacket(
  value:unknown,
):TestComputationPacket {
  if (!isRecord(value)) throw new Error('TEST_COMPUTATION_PACKET_INVALID');
  if (value.kind!=='test') throw new Error('TEST_COMPUTATION_PACKET_SCHEMA_MISMATCH');
  if (value.schema!==REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA) {
    throw new Error('TEST_COMPUTATION_REPLAY_SAFE_PACKET_REQUIRED');
  }

  const keys=Object.keys(value).sort();
  const expected=['execution_context_sha256','kind','process_spec','schema'];
  if (
    keys.length!==expected.length
    || keys.some((key,index)=>key!==expected[index])
  ) {
    throw new Error('TEST_COMPUTATION_PACKET_SHAPE_INVALID');
  }
  if (
    typeof value.execution_context_sha256!=='string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.execution_context_sha256)
  ) {
    throw new Error('TEST_COMPUTATION_EXECUTION_CONTEXT_INVALID');
  }
  return {
    schema:REPLAY_SAFE_TEST_COMPUTATION_PACKET_SCHEMA,
    kind:'test',
    execution_context_sha256:value.execution_context_sha256,
    process_spec:validateProcessSpec(value.process_spec),
  };
}

function attemptSummary(
  evidence:ComputationAttemptEvidenceV1,
):Data {
  if (evidence.schema!==COMPUTATION_EVIDENCE_SCHEMA) {
    throw new Error('COMPUTATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  return {
    schema:COMPUTATION_ATTEMPT_SUMMARY_SCHEMA,
    run_id:evidence.run_id,
    execution_generation:evidence.execution_generation,
    execution_authority_commit:evidence.execution_authority_commit,
    execution_capability_sha256:evidence.execution_capability_sha256,
    execution_spec_sha256:evidence.execution_spec_sha256,
    outcome:evidence.outcome,
    ...(evidence.exit_code===undefined?{}:{exit_code:evidence.exit_code}),
    ...(evidence.signal?{signal:evidence.signal}:{}),
    stdout_sha256:evidence.stdout_sha256,
    stdout_truncated:evidence.stdout_truncated,
    stderr_sha256:evidence.stderr_sha256,
    stderr_truncated:evidence.stderr_truncated,
  };
}

function resultState(receipt:Receipt):TestComputationResult['state'] {
  if (
    receipt.disposition==='DONE'
    || receipt.disposition==='READY'
    || receipt.disposition==='RECOVERY_REQUIRED'
  ) {
    return receipt.disposition;
  }
  throw new Error(`TEST_COMPUTATION_UNEXPECTED_DISPOSITION:${receipt.disposition}`);
}

function readyTestWork(kernel:KernelCore):{
  work:Work;
  packet:TestComputationPacket;
}|null {
  for (const work of kernel.inspect()) {
    if (work.status!=='READY') continue;
    if (!isRecord(work.packet) || work.packet.kind!=='test') continue;
    return {
      work,
      packet:validateTestComputationPacket(work.packet),
    };
  }
  return null;
}

function recoveringTestWork(
  kernel:KernelCore,
  runId:string,
):{
  work:Work;
  packet:TestComputationPacket;
} {
  const work=kernel.inspect().find(candidate=>candidate.run_id===runId);
  if (!work) throw new Error('TEST_COMPUTATION_RUN_NOT_PROJECTED');
  if (work.status!=='RECOVERY_REQUIRED') {
    throw new Error(`TEST_COMPUTATION_NOT_RECOVERABLE:${work.status}`);
  }
  return {
    work,
    packet:validateTestComputationPacket(work.packet),
  };
}

async function assertExecutionContext(
  packet:TestComputationPacket,
  executor:ComputationExecutor,
):Promise<void> {
  await executor.ready?.();
  if (executor.executionContextSha256!==packet.execution_context_sha256) {
    throw new Error('TEST_COMPUTATION_EXECUTION_CONTEXT_MISMATCH');
  }
}

async function executeTestAttempt(
  kernel:KernelCore,
  executor:ComputationExecutor,
  work:Work,
  packet:TestComputationPacket,
  permit:ExecutionPermit,
):Promise<TestComputationResult> {
  const execution=computationExecution(permit,packet.process_spec);
  let evidence:ComputationAttemptEvidenceV1;
  try {
    evidence=await executor.execute(execution);
    assertComputationEvidenceFor(evidence,execution);
  } catch (error:unknown) {
    const transportError=errorMessage(error);
    const receipt=kernel.recoverInterrupted(permit,{
      computation_transport_failure:{
        schema:COMPUTATION_TRANSPORT_FAILURE_SCHEMA,
        execution_spec_sha256:execution.execution_spec_sha256,
        ...(executor.containmentId?{containment_id:executor.containmentId}:{}),
        error:transportError,
      },
    });
    return {
      state:'RECOVERY_REQUIRED',
      work_id:work.id,
      run_id:permit.id,
      execution_generation:permit.execution_generation,
      execution_spec_sha256:execution.execution_spec_sha256,
      receipt,
      transport_error:transportError,
    };
  }

  if (evidence.outcome!=='completed' || evidence.exit_code!==0) {
    const receipt=kernel.recoverInterrupted(permit,{
      computation_attempt:attemptSummary(evidence),
      computation_rejection:'PROCESS_DID_NOT_COMPLETE_SUCCESSFULLY',
    });
    return {
      state:'RECOVERY_REQUIRED',
      work_id:work.id,
      run_id:permit.id,
      execution_generation:permit.execution_generation,
      execution_spec_sha256:execution.execution_spec_sha256,
      receipt,
      evidence,
    };
  }

  const receipt=await kernel.resolveAsync(permit,{
    computation_attempt:attemptSummary(evidence),
  });
  return {
    state:resultState(receipt),
    work_id:work.id,
    run_id:permit.id,
    execution_generation:permit.execution_generation,
    execution_spec_sha256:execution.execution_spec_sha256,
    receipt,
    evidence,
  };
}

export async function runReadyTestComputation(
  kernel:KernelCore,
  executor:ComputationExecutor,
):Promise<TestComputationResult|null> {
  const candidate=readyTestWork(kernel);
  if (!candidate) return null;

  // Validate the exact computation packet before opening a durable claim. An
  // invalid test packet is a definition/admission defect, not a stranded run.
  const {work,packet}=candidate;
  await assertExecutionContext(packet,executor);
  const permit=kernel.claim(work.id,work.revision);
  return await executeTestAttempt(kernel,executor,work,packet,permit);
}

export async function resumeTestComputation(
  kernel:KernelCore,
  executor:ComputationExecutor,
  runId:string,
  recoveryAuthority?:ComputationRecoveryAuthority,
):Promise<TestComputationResult> {
  // Reconstruct the process spec from durable project facts before issuing a
  // fresh execution generation. No in-memory executor queue participates.
  const {work,packet}=recoveringTestWork(kernel,runId);
  if (kernel.hasUnresolvedEffect(runId)) {
    throw new Error('TEST_COMPUTATION_EFFECT_RESERVATION_PRESENT');
  }
  await assertExecutionContext(packet,executor);

  const prior=kernel.receipts(runId).at(-1);
  const diagnostic=isRecord(prior?.diagnostic) ? prior.diagnostic : null;
  const transportFailure=diagnostic && isRecord(diagnostic.computation_transport_failure)
    ? diagnostic.computation_transport_failure
    : null;
  if (transportFailure) {
    const containmentId=transportFailure.containment_id;
    if (typeof containmentId!=='string' || containmentId.length===0) {
      throw new Error('TEST_COMPUTATION_CONTAINMENT_ID_UNAVAILABLE');
    }
    if (!recoveryAuthority) {
      throw new Error('TEST_COMPUTATION_CONTAINMENT_TERMINATION_UNPROVEN');
    }
    await recoveryAuthority.assertTerminated(containmentId);
  }

  const permit=kernel.acquireExecution(runId);
  return await executeTestAttempt(kernel,executor,work,packet,permit);
}
