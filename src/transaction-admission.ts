import type { ExecutionPermit, Run } from './model.ts';

export type TransactionAdmission =
  | {command:'mutate';current_authority:boolean;exact_revision:boolean;unresolved_effect:boolean}
  | {command:'settle';current_authority:boolean;exact_revision:boolean;verified_present:boolean;verified_exact_revision:boolean}
  | {command:'replay';current_authority:boolean;exact_revision:boolean;verified_absent:boolean;verified_exact_revision:boolean}
  | {command:'done';settlement_completed:boolean;settlement_was_authorized:boolean;settlement_evidence_matches:boolean;verified_present:boolean;verified_exact_revision:boolean;evidence_valid:boolean};

export interface MutationAuthorityProjection {
  current_authority:boolean;
  exact_revision:boolean;
  unresolved_effect:boolean;
}

export function projectMutationAuthority(
  run:Run|undefined,
  permit:ExecutionPermit,
  capabilitySha256:string,
  unresolvedEffect:boolean,
):MutationAuthorityProjection {
  return {
    current_authority:run!==undefined
      && permit.id===run.id
      && permit.obligation_id===run.obligation_id
      && permit.execution_generation===run.execution_generation
      && permit.execution_authority_commit===run.execution_authority_commit
      && permit.execution_capability_sha256===run.execution_capability_sha256
      && capabilitySha256===run.execution_capability_sha256,
    exact_revision:run!==undefined
      && permit.claimed_revision===run.claimed_revision
      && permit.claim_commit===run.claim_commit
      && permit.obligation_key===run.obligation_key,
    unresolved_effect:unresolvedEffect,
  };
}

export function transactionAdmitted(s:TransactionAdmission):boolean {
  switch(s.command){
    case 'mutate':
      return s.current_authority && s.exact_revision && !s.unresolved_effect;
    case 'settle':
      return s.current_authority && s.exact_revision &&
        s.verified_present && s.verified_exact_revision;
    case 'replay':
      return s.current_authority && s.exact_revision &&
        s.verified_absent && s.verified_exact_revision;
    case 'done':
      return s.settlement_completed && s.settlement_was_authorized &&
        s.settlement_evidence_matches && s.verified_present &&
        s.verified_exact_revision && s.evidence_valid;
  }
}
