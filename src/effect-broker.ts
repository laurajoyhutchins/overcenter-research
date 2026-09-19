import type { Work } from './model.ts';
import type { GitOvercenterKernel } from './git-kernel.ts';
import {
  validateEffectReadySignal,
  type EffectReadySignal,
} from './execution-signal.ts';
import {
  deriveAuthorizedProviderEffect,
  executeAuthorizedProviderEffect,
  type AuthorizedProviderEffect,
  type ProviderEffectAttemptEvidence,
  type ProviderEffectExecutionContext,
} from './provider-effect.ts';

export const TASK_SESSION_SCHEMA='overcenter-task-session-v1' as const;

export interface TaskSession {
  schema:typeof TASK_SESSION_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  execution_generation:number;
}

export interface AuthorizedEffectAttempt {
  session:TaskSession;
  effect:AuthorizedProviderEffect;
  evidence:ProviderEffectAttemptEvidence;
  broker_execution_generation:number;
}

export function bindTaskSession(work:Work):TaskSession {
  if (work.status!=='EXECUTING') throw new Error('TASK_SESSION_WORK_NOT_EXECUTING');
  if (!work.run_id) throw new Error('TASK_SESSION_RUN_MISSING');
  if (!work.claimed_revision) throw new Error('TASK_SESSION_REVISION_MISSING');
  if (!work.execution_generation) throw new Error('TASK_SESSION_GENERATION_MISSING');

  return {
    schema:TASK_SESSION_SCHEMA,
    run_id:work.run_id,
    obligation_id:work.id,
    claimed_revision:work.claimed_revision,
    execution_generation:work.execution_generation,
  };
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
  if (work.execution_generation!==session.execution_generation) {
    throw new Error('TASK_SESSION_STALE');
  }

  return work;
}

export async function executeEffectReady(
  kernel:GitOvercenterKernel,
  session:TaskSession,
  candidateSignal:unknown,
  context:ProviderEffectExecutionContext,
):Promise<AuthorizedEffectAttempt> {
  validateEffectReadySignal(candidateSignal);

  const work=resolveTaskSession(kernel.inspect(),session);
  const effect=deriveAuthorizedProviderEffect(work);
  if (!effect) throw new Error('AUTHORIZED_EFFECT_UNAVAILABLE');

  const permit=kernel.acquireExecution(session.run_id,{
    expectedGeneration:session.execution_generation,
  });

  const evidence=await kernel.performEffect(
    permit,
    ()=>executeAuthorizedProviderEffect(effect,context),
  );

  return {
    session,
    effect,
    evidence,
    broker_execution_generation:permit.execution_generation,
  };
}

export type { EffectReadySignal };
