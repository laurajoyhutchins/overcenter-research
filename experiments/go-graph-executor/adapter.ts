import type { ExecutionPermit } from '../../src/model.ts';

export interface GraphExecutionEnvelope {
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  execution_generation:number;
  execution_authority_commit:string;
  execution_capability:string;
  execution_capability_sha256:string;
  effect_reservation_commit?:string;
  execution_spec_sha256:string;
  execution_spec:unknown;
}

export interface GraphExecutionEvidence {
  schema:'overcenter-execution-attempt-evidence-v1';
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  execution_generation:number;
  execution_authority_commit:string;
  execution_capability_sha256:string;
  effect_reservation_commit?:string;
  execution_spec_sha256:string;
  outcome:'completed'|'failed'|'cancelled';
  output_base64?:string;
  output_sha256?:string;
  error?:string;
}

export function executionEnvelope(
  permit:ExecutionPermit,
  {
    executionSpec,
    executionSpecSha256,
    effectReservationCommit,
  }:{
    executionSpec:unknown;
    executionSpecSha256:string;
    effectReservationCommit?:string;
  },
):GraphExecutionEnvelope {
  return {
    run_id:permit.id,
    obligation_id:permit.obligation_id,
    claimed_revision:permit.claimed_revision,
    execution_generation:permit.execution_generation,
    execution_authority_commit:permit.execution_authority_commit,
    execution_capability:permit.execution_capability,
    execution_capability_sha256:permit.execution_capability_sha256,
    ...(effectReservationCommit?{effect_reservation_commit:effectReservationCommit}:{}),
    execution_spec_sha256:executionSpecSha256,
    execution_spec:structuredClone(executionSpec),
  };
}

export function assertExecutionEvidenceFor(
  evidence:GraphExecutionEvidence,
  envelope:GraphExecutionEnvelope,
):void {
  if (evidence.schema!=='overcenter-execution-attempt-evidence-v1') {
    throw new Error('EXECUTION_EVIDENCE_SCHEMA_MISMATCH');
  }
  if (
    evidence.run_id!==envelope.run_id
    || evidence.obligation_id!==envelope.obligation_id
    || evidence.claimed_revision!==envelope.claimed_revision
    || evidence.execution_generation!==envelope.execution_generation
    || evidence.execution_authority_commit!==envelope.execution_authority_commit
    || evidence.execution_capability_sha256!==envelope.execution_capability_sha256
    || evidence.effect_reservation_commit!==envelope.effect_reservation_commit
  ) {
    throw new Error('EXECUTION_EVIDENCE_AUTHORITY_MISMATCH');
  }
  if (evidence.execution_spec_sha256!==envelope.execution_spec_sha256) {
    throw new Error('EXECUTION_EVIDENCE_SPEC_MISMATCH');
  }
}
