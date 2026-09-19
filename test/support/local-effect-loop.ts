import type { KernelCore } from '../../src/kernel-core.ts';
import type { Data, ExecutionPermit } from '../../src/model.ts';

type LocalEffectOutcome=Data & {
  kind?:string;
  may_have_mutated?:boolean;
};

interface LocalEffectLoopOptions {
  preflight?:(packet:Data)=>Promise<Data & {kind:'execute'|'judgment-required'}>;
  effect:(packet:Data)=>Promise<LocalEffectOutcome>;
  maxAdvances?:number;
}

interface LocalEffectLoopResult {
  state:'IDLE'|'BLOCKED'|'RECOVERY_REQUIRED'|'WAITING'|'BUDGET_EXHAUSTED';
  advances:number;
  work?:string;
  run?:string;
}

const errorMessage=(error:unknown)=>error instanceof Error ? error.message : String(error);

/**
 * Test-only compatibility harness for historical local-effect semantics.
 *
 * Production code deliberately exposes no arbitrary effect callback. Provider
 * mutation must pass through an explicit broker with exact effect identity.
 */
export async function runLocalEffectLoopForTest(
  kernel:KernelCore,
  {preflight,effect,maxAdvances=100}:LocalEffectLoopOptions,
):Promise<LocalEffectLoopResult> {
  kernel.inspect();
  for (let i=0;i<maxAdvances;i+=1) {
    const work=kernel.deriveReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) return {state:'BLOCKED',work:blocked.id,advances:i};
      return {state:'IDLE',advances:i};
    }
    if (work.effect_authority || 'provider' in work.postcondition) {
      throw new Error('TEST_LOCAL_EFFECT_PROVIDER_FORBIDDEN');
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

    let outcome:LocalEffectOutcome;
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
      kernel.recoverInterrupted(run,{
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

    const receipt=kernel.resolve(run);
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') continue;
    return {
      state:'RECOVERY_REQUIRED',
      work:work.id,
      run:run.id,
      advances:i+1,
    };
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
