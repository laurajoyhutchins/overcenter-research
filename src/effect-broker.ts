import type {
  TaskSession,
  Work,
} from './model.ts';
import type { KernelCore } from './kernel-core.ts';
import {
  deriveAuthorizedProviderEffect,
  executeAuthorizedProviderEffect,
  type AuthorizedProviderEffect,
  type ProviderEffectAttemptEvidence,
  type ProviderEffectExecutionContext,
} from './provider-effect.ts';

export const TASK_SESSION_SCHEMA='overcenter-task-session-v2' as const;

export interface AuthorizedEffectAttempt {
  session:TaskSession;
  authorized_effect:AuthorizedProviderEffect;
  evidence:ProviderEffectAttemptEvidence;
  broker_execution_generation:number;
  reservation_commit:string;
}

export function bindTaskSession(work:Work):TaskSession {
  if (work.status!=='EXECUTING') throw new Error('TASK_SESSION_WORK_NOT_EXECUTING');
  if (!work.run_id) throw new Error('TASK_SESSION_RUN_MISSING');
  if (!work.claimed_revision) throw new Error('TASK_SESSION_REVISION_MISSING');
  if (!work.execution_generation) throw new Error('TASK_SESSION_GENERATION_MISSING');
  if (!work.execution_authority_commit) {
    throw new Error('TASK_SESSION_AUTHORITY_COMMIT_MISSING');
  }

  return {
    schema:TASK_SESSION_SCHEMA,
    run_id:work.run_id,
    obligation_id:work.id,
    claimed_revision:work.claimed_revision,
    execution_generation:work.execution_generation,
    execution_authority_commit:work.execution_authority_commit,
  };
}

export function validateTaskSession(candidate:unknown):TaskSession {
  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate)) {
    throw new Error('TASK_SESSION_INVALID');
  }
  const record=candidate as Record<string,unknown>;
  const expectedKeys=[
    'claimed_revision',
    'execution_authority_commit',
    'execution_generation',
    'obligation_id',
    'run_id',
    'schema',
  ];
  if (
    JSON.stringify(Object.keys(record).sort())!==JSON.stringify(expectedKeys)
    || record.schema!==TASK_SESSION_SCHEMA
    || typeof record.run_id!=='string'
    || typeof record.obligation_id!=='string'
    || typeof record.claimed_revision!=='string'
    || !Number.isInteger(record.execution_generation)
    || Number(record.execution_generation)<1
    || typeof record.execution_authority_commit!=='string'
  ) {
    throw new Error('TASK_SESSION_INVALID');
  }
  return structuredClone(record) as unknown as TaskSession;
}

export function resolveTaskSession(
  works:readonly Work[],
  session:TaskSession,
):Work {
  const matches=works.filter(work=>work.run_id===session.run_id);
  if (matches.length!==1) throw new Error('TASK_SESSION_RUN_NOT_UNIQUE');
  const work=matches[0];

  if (
    work.id!==session.obligation_id
    || work.claimed_revision!==session.claimed_revision
  ) {
    throw new Error('TASK_SESSION_IDENTITY_MISMATCH');
  }
  if (work.status!=='EXECUTING') throw new Error('TASK_SESSION_WORK_NOT_EXECUTING');
  if (
    work.execution_generation!==session.execution_generation
    || work.execution_authority_commit!==session.execution_authority_commit
  ) {
    throw new Error('TASK_SESSION_STALE');
  }

  return work;
}

export async function executeAuthorizedEffect(
  kernel:KernelCore,
  session:TaskSession,
  context:ProviderEffectExecutionContext,
):Promise<AuthorizedEffectAttempt> {
  const work=resolveTaskSession(kernel.inspect(),session);
  const authorizedEffect=deriveAuthorizedProviderEffect(work);
  if (!authorizedEffect) throw new Error('EFFECT_AUTHORITY_REQUIRED');

  const realization=work.result_acceptance
    ? kernel.acceptedRealization(session)
    : null;
  if (work.result_acceptance && !realization) {
    throw new Error('REALIZATION_REQUIRED');
  }

  const permit=kernel.acquireExecution(session.run_id,{
    expectedGeneration:session.execution_generation,
    expectedAuthorityCommit:session.execution_authority_commit,
  });

  const reservationCommit=kernel.beginEffect(permit,{
    effect_contract:authorizedEffect.effect_contract,
    adapter_contract_digest:authorizedEffect.adapter_contract_digest,
    effect_digest:authorizedEffect.effect_digest,
    realization_commit:realization?.realization_commit??null,
    realization_digest:realization?.result_digest??null,
  });

  const evidence=await executeAuthorizedProviderEffect(authorizedEffect,context);

  return {
    session,
    authorized_effect:authorizedEffect,
    evidence,
    broker_execution_generation:permit.execution_generation,
    reservation_commit:reservationCommit,
  };
}
