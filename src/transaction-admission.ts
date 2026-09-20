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

export const mutationAdmitted=(
  s:ExecutionAuthorityProjection&{unresolved_effect:boolean},
)=>s.current_authority&&s.exact_revision&&!s.unresolved_effect;
