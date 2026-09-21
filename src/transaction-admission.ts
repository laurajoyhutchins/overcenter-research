import type { EffectReservationFact, ReceiptFact } from './facts.ts';
import type { ExecutionPermit, Run } from './model.ts';

export interface ExecutionAuthorityProjection {
  current_authority:boolean;
  exact_revision:boolean;
}

export function projectExecutionAuthority(
  run:Run,
  permit:ExecutionPermit,
  capabilitySha256:string,
):ExecutionAuthorityProjection {
  return {
    current_authority:permit.id===run.id
      && permit.obligation_id===run.obligation_id
      && permit.execution_generation===run.execution_generation
      && permit.execution_authority_commit===run.execution_authority_commit
      && permit.execution_capability_sha256===run.execution_capability_sha256
      && capabilitySha256===run.execution_capability_sha256,
    exact_revision:permit.claimed_revision===run.claimed_revision
      && permit.claim_commit===run.claim_commit
      && permit.obligation_key===run.obligation_key,
  };
}

export type EffectReservationAuthorityError =
  | 'EFFECT_RESERVATION_RUN_MISMATCH'
  | 'EFFECT_RESERVATION_OBLIGATION_MISMATCH'
  | 'STALE_EFFECT_RESERVATION'
  | 'DUPLICATE_UNRESOLVED_EFFECT'
  | null;

export function effectReservationAuthorityError(
  run:Run,
  fact:EffectReservationFact,
  unresolvedEffect:boolean,
):EffectReservationAuthorityError {
  if (fact.run_id!==run.id) return 'EFFECT_RESERVATION_RUN_MISMATCH';
  if (fact.obligation_id!==run.obligation_id) {
    return 'EFFECT_RESERVATION_OBLIGATION_MISMATCH';
  }
  if (
    fact.execution_generation!==run.execution_generation
    || fact.execution_authority_commit!==run.execution_authority_commit
  ) return 'STALE_EFFECT_RESERVATION';
  return unresolvedEffect ? 'DUPLICATE_UNRESOLVED_EFFECT' : null;
}


export type ReceiptAuthorityError =
  | 'RECEIPT_RUN_MISMATCH'
  | 'RECEIPT_OBLIGATION_MISMATCH'
  | 'RECEIPT_REVISION_MISMATCH'
  | 'RECEIPT_CLAIM_MISMATCH'
  | 'RECEIPT_EXECUTION_AUTHORITY_MISMATCH'
  | null;

export function receiptAuthorityError(
  run:Run,
  fact:ReceiptFact,
):ReceiptAuthorityError {
  if (fact.run_id!==run.id) return 'RECEIPT_RUN_MISMATCH';
  if (fact.obligation_id!==run.obligation_id) return 'RECEIPT_OBLIGATION_MISMATCH';
  if (fact.claimed_revision!==run.claimed_revision) return 'RECEIPT_REVISION_MISMATCH';
  if (fact.claim_commit!==run.claim_commit) return 'RECEIPT_CLAIM_MISMATCH';
  if (
    fact.execution_generation!==run.execution_generation
    || fact.execution_authority_commit!==run.execution_authority_commit
  ) return 'RECEIPT_EXECUTION_AUTHORITY_MISMATCH';
  return null;
}

export const mutationAdmitted=(
  s:ExecutionAuthorityProjection&{unresolved_effect:boolean},
)=>s.current_authority&&s.exact_revision&&!s.unresolved_effect;
