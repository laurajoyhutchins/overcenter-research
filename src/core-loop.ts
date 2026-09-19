import type {
  Data,
  ExecutionPermit,
} from './model.ts';
import { GitOvercenterKernel } from './git-kernel.ts';

export interface ExecuteOutcome extends Data {
  kind?:string;
  may_have_mutated?:boolean;
}

export interface PreflightOutcome extends Data {
  kind:'execute'|'judgment-required';
}

export interface LoopOptions {
  preflight?:(packet:Data)=>Promise<PreflightOutcome>;
  effect:(packet:Data)=>Promise<ExecuteOutcome>;
  maxAdvances?:number;
}

export interface LoopResult {
  state:'IDLE'|'BLOCKED'|'RECOVERY_REQUIRED'|'WAITING'|'BUDGET_EXHAUSTED';
  advances:number;
  work?:string;
  run?:string;
}

const errorMessage=(error:unknown)=>error instanceof Error ? error.message : String(error);

export async function runGitCoreLoop(
  kernel:GitOvercenterKernel,
  {preflight,effect,maxAdvances=100}:LoopOptions,
):Promise<LoopResult> {
  kernel.inspect();
  for (let i=0;i<maxAdvances;i+=1) {
    const work=kernel.nextReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) return {state:'BLOCKED',work:blocked.id,advances:i};
      return {state:'IDLE',advances:i};
    }

    let run:ExecutionPermit;
    try {
      run=kernel.claim(work.id,work.revision);
    } catch (error:unknown) {
      const message=errorMessage(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }

    if (preflight) {
      const decision=await preflight(work.packet);
      if (decision.kind==='judgment-required') {
        kernel.deferForJudgment(run,{decision});
        return {state:'WAITING',work:work.id,run:run.id,advances:i+1};
      }
      if (decision.kind!=='execute') throw new Error('INVALID_PREFLIGHT_OUTCOME');
    }

    kernel.beginEffect(run);

    let outcome:ExecuteOutcome;
    try {
      outcome=await effect(work.packet);
    } catch (error:unknown) {
      outcome={
        kind:'execution-error',
        error:errorMessage(error),
        may_have_mutated:true,
      };
    }

    if (outcome.kind==='judgment-required') {
      kernel.recordExecutionTerminated(run,{
        outcome,
        protocol_error:'JUDGMENT_AFTER_EFFECT_RESERVATION',
      });
      return {
        state:'RECOVERY_REQUIRED',
        work:work.id,
        run:run.id,
        advances:i+1,
      };
    }

    const receipt=kernel.reconcile(run);
    if (receipt.disposition==='DONE' || receipt.disposition==='ABSENT') continue;
    return {
      state:'RECOVERY_REQUIRED',
      work:work.id,
      run:run.id,
      advances:i+1,
    };
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
