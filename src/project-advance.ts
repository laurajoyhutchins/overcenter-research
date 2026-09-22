import type {KernelCore,Receipt} from './kernel-core.ts';
import type {
  Data,
  ExecutionPermit,
  Work,
} from './model.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from './providers/github-status-effect.ts';

export const PROJECT_ADVANCE_RESULT_SCHEMA='overcenter-project-advance-result/v1' as const;
export const WORK_EXECUTION_RESULT_SCHEMA='overcenter-work-execution-result/v1' as const;
export const AGENT_AUTHORIZATION_POLICY='agent-authorization/v1' as const;
export const WORK_EXECUTE_ACTION='work.execute' as const;

export type ProjectAdvanceOutcome=
  | 'IDLE'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'AGENT_EXECUTION_REQUIRED'
  | 'BUDGET_EXHAUSTED';

export interface AgentExecutionPacket {
  schema:'overcenter-agent-execution-packet/v1';
  outcome:'AGENT_EXECUTION_REQUIRED';
  authority_revision:string;
  work:Work;
  run_id:string;
  reason:string;
  allowed_actions:string[];
}

export type ProjectAdvanceResult=
  | {
      schema:typeof PROJECT_ADVANCE_RESULT_SCHEMA;
      outcome:'IDLE';
      authority_revision:string;
      advances:number;
    }
  | {
      schema:typeof PROJECT_ADVANCE_RESULT_SCHEMA;
      outcome:'BLOCKED'|'RECOVERY_REQUIRED';
      authority_revision:string;
      advances:number;
      work:Work;
    }
  | {
      schema:typeof PROJECT_ADVANCE_RESULT_SCHEMA;
      outcome:'AGENT_EXECUTION_REQUIRED';
      authority_revision:string;
      advances:number;
      packet:AgentExecutionPacket;
    }
  | {
      schema:typeof PROJECT_ADVANCE_RESULT_SCHEMA;
      outcome:'BUDGET_EXHAUSTED';
      authority_revision:string;
      advances:number;
    };

export type WorkExecutionResult=
  | {
      schema:typeof WORK_EXECUTION_RESULT_SCHEMA;
      outcome:'DONE'|'READY'|'RECOVERY_REQUIRED';
      authority_revision:string;
      work:Work;
      receipt:Receipt;
    }
  | {
      schema:typeof WORK_EXECUTION_RESULT_SCHEMA;
      outcome:'AGENT_EXECUTION_REQUIRED';
      authority_revision:string;
      work:Work;
      reason:string;
    };

export type EffectExecutor=(
  kernel:KernelCore,
  permit:ExecutionPermit,
  work:Work,
)=>Promise<Data>;

function errorMessage(error:unknown):string {
  return error instanceof Error ? error.message : String(error);
}

function authorityRevision(kernel:KernelCore):string {
  const revision=kernel.head();
  if (!revision) throw new Error('PROJECT_ADVANCE_AUTHORITY_UNINITIALIZED');
  return revision;
}

function currentWork(kernel:KernelCore,id:string):Work {
  const work=kernel.inspect().find(candidate=>candidate.id===id);
  if (!work) throw new Error(`PROJECT_ADVANCE_WORK_MISSING:${id}`);
  return work;
}

function singleInFlight(kernel:KernelCore,status:'WAITING'|'RECOVERY_REQUIRED'|'EXECUTING'):Work|null {
  const matches=kernel.inspect().filter(work=>work.status===status);
  if (matches.length>1) {
    throw new Error(`PROJECT_ADVANCE_AMBIGUOUS_${status}`);
  }
  return matches[0]??null;
}

function supportedEffect(work:Work):boolean {
  return work.packet.effect_contract===GITHUB_COMMIT_STATUS_EFFECT;
}

function requiresAgentAuthorization(work:Work):boolean {
  return work.packet.execution_policy===AGENT_AUTHORIZATION_POLICY;
}

function agentReason(work:Work):string {
  if (requiresAgentAuthorization(work) && supportedEffect(work)) {
    return 'AGENT_AUTHORIZATION_REQUIRED';
  }
  if (!supportedEffect(work)) {
    return 'NO_DETERMINISTIC_EFFECT_EXECUTOR';
  }
  return 'AGENT_JUDGMENT_REQUIRED';
}

function allowedActions(work:Work):string[] {
  return requiresAgentAuthorization(work) && supportedEffect(work)
    ? [WORK_EXECUTE_ACTION]
    : [];
}

function agentPacket(
  kernel:KernelCore,
  work:Work,
  reason=agentReason(work),
):AgentExecutionPacket {
  if (!work.run_id) throw new Error('PROJECT_ADVANCE_WAITING_RUN_MISSING');
  return {
    schema:'overcenter-agent-execution-packet/v1',
    outcome:'AGENT_EXECUTION_REQUIRED',
    authority_revision:authorityRevision(kernel),
    work:structuredClone(work),
    run_id:work.run_id,
    reason,
    allowed_actions:allowedActions(work),
  };
}

async function defaultEffectExecutor(
  kernel:KernelCore,
  permit:ExecutionPermit,
  work:Work,
):Promise<Data> {
  if (work.packet.effect_contract!==GITHUB_COMMIT_STATUS_EFFECT) {
    throw new Error('PROJECT_ADVANCE_EFFECT_UNSUPPORTED');
  }
  const token=kernel.githubToken;
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  return performGithubCommitStatusEffect(kernel,permit,{token});
}

async function handleEffectFailure(
  kernel:KernelCore,
  permit:ExecutionPermit,
  workId:string,
  error:unknown,
):Promise<ProjectAdvanceResult> {
  const message=errorMessage(error);
  if (kernel.hasUnresolvedEffect(permit.id)) {
    const receipt=kernel.recoverInterrupted(permit,{
      source:'project.advance',
      error:message,
    });
    return {
      schema:PROJECT_ADVANCE_RESULT_SCHEMA,
      outcome:'RECOVERY_REQUIRED',
      authority_revision:authorityRevision(kernel),
      advances:1,
      work:currentWork(kernel,receipt.obligation_id),
    };
  }

  kernel.deferForJudgment(permit,{
    decision:{
      kind:'judgment-required',
      reason:'DETERMINISTIC_EFFECT_FAILED_BEFORE_RESERVATION',
      error:message,
    },
  });
  const waiting=currentWork(kernel,workId);
  return {
    schema:PROJECT_ADVANCE_RESULT_SCHEMA,
    outcome:'AGENT_EXECUTION_REQUIRED',
    authority_revision:authorityRevision(kernel),
    advances:1,
    packet:agentPacket(
      kernel,
      waiting,
      'DETERMINISTIC_EFFECT_FAILED_BEFORE_RESERVATION',
    ),
  };
}

export async function advanceProject(
  kernel:KernelCore,
  {
    executeEffect=defaultEffectExecutor,
    maxAdvances=100,
  }:{
    executeEffect?:EffectExecutor;
    maxAdvances?:number;
  }={},
):Promise<ProjectAdvanceResult> {
  if (!Number.isSafeInteger(maxAdvances) || maxAdvances<1) {
    throw new Error('PROJECT_ADVANCE_BUDGET_INVALID');
  }

  for (let advances=0;advances<maxAdvances;advances+=1) {
    const recovery=singleInFlight(kernel,'RECOVERY_REQUIRED');
    if (recovery) {
      return {
        schema:PROJECT_ADVANCE_RESULT_SCHEMA,
        outcome:'RECOVERY_REQUIRED',
        authority_revision:authorityRevision(kernel),
        advances,
        work:recovery,
      };
    }

    const executing=singleInFlight(kernel,'EXECUTING');
    if (executing) {
      return {
        schema:PROJECT_ADVANCE_RESULT_SCHEMA,
        outcome:'RECOVERY_REQUIRED',
        authority_revision:authorityRevision(kernel),
        advances,
        work:executing,
      };
    }

    const waiting=singleInFlight(kernel,'WAITING');
    if (waiting) {
      if (!waiting.run_id) throw new Error('PROJECT_ADVANCE_WAITING_RUN_MISSING');
      const permit=kernel.acquireExecution(waiting.run_id);
      const settled=await kernel.reconcileIfVerified(permit,{
        source:'project.advance:waiting-reconcile',
      });
      if (settled?.disposition==='DONE' || settled?.disposition==='READY') {
        continue;
      }
      const current=currentWork(kernel,waiting.id);
      return {
        schema:PROJECT_ADVANCE_RESULT_SCHEMA,
        outcome:'AGENT_EXECUTION_REQUIRED',
        authority_revision:authorityRevision(kernel),
        advances,
        packet:agentPacket(kernel,current),
      };
    }

    const work=kernel.deriveReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) {
        return {
          schema:PROJECT_ADVANCE_RESULT_SCHEMA,
          outcome:'BLOCKED',
          authority_revision:authorityRevision(kernel),
          advances,
          work:blocked,
        };
      }
      return {
        schema:PROJECT_ADVANCE_RESULT_SCHEMA,
        outcome:'IDLE',
        authority_revision:authorityRevision(kernel),
        advances,
      };
    }

    let permit:ExecutionPermit;
    try {
      permit=kernel.claim(work.id,work.revision);
    } catch (error:unknown) {
      const message=errorMessage(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }

    const claimed=kernel.claimedWork(permit.id);
    if (requiresAgentAuthorization(claimed) || !supportedEffect(claimed)) {
      kernel.deferForJudgment(permit,{
        decision:{
          kind:'judgment-required',
          reason:agentReason(claimed),
          allowed_actions:allowedActions(claimed),
        },
      });
      const current=currentWork(kernel,claimed.id);
      return {
        schema:PROJECT_ADVANCE_RESULT_SCHEMA,
        outcome:'AGENT_EXECUTION_REQUIRED',
        authority_revision:authorityRevision(kernel),
        advances:advances+1,
        packet:agentPacket(kernel,current),
      };
    }

    try {
      await executeEffect(kernel,permit,claimed);
    } catch (error:unknown) {
      const failed=await handleEffectFailure(kernel,permit,claimed.id,error);
      return {
        ...failed,
        advances:advances+1,
      };
    }

    const receipt=await kernel.resolveAsync(permit,{
      source:'project.advance:auto',
    });
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') {
      continue;
    }
    return {
      schema:PROJECT_ADVANCE_RESULT_SCHEMA,
      outcome:'RECOVERY_REQUIRED',
      authority_revision:authorityRevision(kernel),
      advances:advances+1,
      work:currentWork(kernel,claimed.id),
    };
  }

  return {
    schema:PROJECT_ADVANCE_RESULT_SCHEMA,
    outcome:'BUDGET_EXHAUSTED',
    authority_revision:authorityRevision(kernel),
    advances:maxAdvances,
  };
}

export async function executeWaitingWork(
  kernel:KernelCore,
  {
    executeEffect=defaultEffectExecutor,
  }:{
    executeEffect?:EffectExecutor;
  }={},
):Promise<WorkExecutionResult> {
  const recovery=singleInFlight(kernel,'RECOVERY_REQUIRED');
  if (recovery) {
    throw new Error('WORK_EXECUTE_RECOVERY_REQUIRED');
  }
  const executing=singleInFlight(kernel,'EXECUTING');
  if (executing) {
    throw new Error('WORK_EXECUTE_ACTIVE_EXECUTION');
  }

  const waiting=singleInFlight(kernel,'WAITING');
  if (!waiting) throw new Error('WORK_EXECUTE_NO_WAITING_WORK');
  if (!waiting.run_id) throw new Error('WORK_EXECUTE_RUN_MISSING');
  if (!requiresAgentAuthorization(waiting)) {
    throw new Error('WORK_EXECUTE_NOT_AUTHORIZED_BY_PACKET');
  }
  if (!supportedEffect(waiting)) {
    throw new Error('WORK_EXECUTE_EFFECT_UNSUPPORTED');
  }

  const permit=kernel.acquireExecution(waiting.run_id);
  const claimed=kernel.claimedWork(waiting.run_id);
  try {
    await executeEffect(kernel,permit,claimed);
  } catch (error:unknown) {
    const message=errorMessage(error);
    if (kernel.hasUnresolvedEffect(permit.id)) {
      const receipt=kernel.recoverInterrupted(permit,{
        source:'work.execute',
        error:message,
      });
      return {
        schema:WORK_EXECUTION_RESULT_SCHEMA,
        outcome:'RECOVERY_REQUIRED',
        authority_revision:authorityRevision(kernel),
        work:currentWork(kernel,waiting.id),
        receipt,
      };
    }
    return {
      schema:WORK_EXECUTION_RESULT_SCHEMA,
      outcome:'AGENT_EXECUTION_REQUIRED',
      authority_revision:authorityRevision(kernel),
      work:currentWork(kernel,waiting.id),
      reason:`DETERMINISTIC_EFFECT_FAILED_BEFORE_RESERVATION:${message}`,
    };
  }

  const receipt=await kernel.resolveAsync(permit,{
    source:'work.execute',
    authorization:'agent-semantic-command',
  });
  return {
    schema:WORK_EXECUTION_RESULT_SCHEMA,
    outcome:receipt.disposition,
    authority_revision:authorityRevision(kernel),
    work:currentWork(kernel,waiting.id),
    receipt,
  };
}
