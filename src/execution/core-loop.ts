import type { KernelCore } from '../authority/engine.ts';
import type { ExecuteOutcome, ExecutionPermit, LoopOptions, LoopResult, Work } from '../model.ts';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runCoreLoop(
  kernel: KernelCore,
  { preflight, effect, maxAdvances = 100, concurrency = 1 }: LoopOptions,
): Promise<LoopResult> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('INVALID_CONCURRENCY');
  }

  kernel.inspect();
  let advances = 0;

  while (advances < maxAdvances) {
    const active: Array<{
      work: Work;
      run: ExecutionPermit;
      outcome: Promise<ExecuteOutcome>;
    }> = [];
    let deferred: LoopResult | null = null;
    let pendingError: { error: unknown } | null = null;
    let noReady = false;

    while (active.length < concurrency && advances < maxAdvances && !deferred && !pendingError) {
      const work = kernel.deriveReadyWork();
      if (!work) {
        noReady = true;
        break;
      }

      let run: ExecutionPermit;
      try {
        run = kernel.claim(work.id, work.revision);
      } catch (error: unknown) {
        const message = errorMessage(error);
        if (message === 'STALE_REVISION' || message === 'CLAIM_LOST') continue;
        pendingError = { error };
        break;
      }
      advances += 1;

      let outcome: Promise<ExecuteOutcome>;
      try {
        if (preflight) {
          const decision = await preflight(work.packet);
          if (decision.kind === 'judgment-required') {
            kernel.deferForJudgment(run, { decision });
            deferred = {
              state: 'WAITING',
              work: work.id,
              run: run.id,
              advances,
            };
            break;
          }
          if (decision.kind !== 'execute') {
            throw new Error('INVALID_PREFLIGHT_OUTCOME');
          }
        }

        // The deterministic kernel mints authority and reserves before the
        // packet-only effect handler can run.
        const authority = kernel.authorizeEffect(run);
        outcome = kernel.performEffect(authority, async () => {
          try {
            return await effect(work.packet);
          } catch (error: unknown) {
            return {
              kind: 'execution-error',
              error: errorMessage(error),
              may_have_mutated: true,
            };
          }
        });
      } catch (error: unknown) {
        pendingError = { error };
        break;
      }

      active.push({ work, run, outcome });
    }

    let recovery: LoopResult | null = null;
    let drainError: { error: unknown } | null = null;
    if (active.length > 0) {
      const outcomes = await Promise.all(active.map((item) => item.outcome));

      // Every started effect is drained before the loop returns. Observation
      // and settlement remain serialized through this one authority lane.
      for (let index = 0; index < active.length; index += 1) {
        const { work, run } = active[index]!;
        const outcome = outcomes[index]!;
        try {
          if (outcome.kind === 'judgment-required') {
            kernel.recoverInterrupted(run, {
              outcome,
              protocol_error: 'JUDGMENT_AFTER_EFFECT_RESERVATION',
            });
            recovery ??= {
              state: 'RECOVERY_REQUIRED',
              work: work.id,
              run: run.id,
              advances,
            };
            continue;
          }

          const receipt = await kernel.resolveAsync(run);
          if (receipt.disposition !== 'DONE' && receipt.disposition !== 'READY') {
            recovery ??= {
              state: 'RECOVERY_REQUIRED',
              work: work.id,
              run: run.id,
              advances,
            };
          }
        } catch (error: unknown) {
          drainError ??= { error };
        }
      }
    }

    if (pendingError) throw pendingError.error;
    if (drainError) throw drainError.error;
    if (recovery) return recovery;
    if (deferred) return deferred;

    if (active.length > 0) continue;

    if (noReady) {
      const blocked = kernel.inspect().find((candidate) => candidate.status === 'BLOCKED');
      if (blocked) return { state: 'BLOCKED', work: blocked.id, advances };
      return { state: 'IDLE', advances };
    }
  }

  return { state: 'BUDGET_EXHAUSTED', advances };
}
