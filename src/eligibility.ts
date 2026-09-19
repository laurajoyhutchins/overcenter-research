import type {
  Obligation,
  Work,
} from './model.ts';
import type { State } from './facts.ts';
import { dependencyUpstreams } from './graph.ts';
import type { Lifecycle } from './lifecycle.ts';
import { staticEffectConflictError } from './admission.ts';

export function claimabilityError(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
):string|null {
  const realization=lifecycles.get(work.id)?.status??'UNREALIZED';
  if (realization!=='UNREALIZED') return 'NOT_READY';

  const done=new Set(
    Object.values(state.obligations)
      .filter(candidate=>lifecycles.get(candidate.id)?.status==='DONE')
      .map(candidate=>candidate.id),
  );
  if (!dependencyUpstreams(work).every(dependency=>done.has(dependency))) {
    return 'DEPENDENCIES_NOT_DONE';
  }

  // New mutations should have been rejected at admission. Keep this check as
  // a defensive projection for legacy or externally constructed histories so
  // an older valid v3 history cannot become executable merely because policy
  // moved earlier.
  return staticEffectConflictError(state,work.id);
}

export function executableFrontier(
  state:State,
  lifecycles:Map<string,Lifecycle>,
):Obligation[] {
  return Object.values(state.obligations)
    .filter(work=>claimabilityError(state,work,lifecycles)===null)
    .sort((a,b)=>a.id.localeCompare(b.id))
    .map(work=>structuredClone(work));
}

export function projectWork(
  state:State,
  work:Obligation,
  revision:string,
  lifecycles:Map<string,Lifecycle>,
):Work {
  const lifecycle=lifecycles.get(work.id)??{status:'UNREALIZED' as const};
  const status=lifecycle.status==='UNREALIZED' ? 'READY' : lifecycle.status;
  const projected={
    ...structuredClone(work),
    status,
    revision,
    ...(lifecycle.run
      ? {
          run_id:lifecycle.run.id,
          claimed_revision:lifecycle.run.claimed_revision,
          execution_generation:lifecycle.run.execution_generation,
        }
      : {}),
  } as Work;

  if (lifecycle.status!=='UNREALIZED') return projected;

  const reason=claimabilityError(state,work,lifecycles);
  if (reason && reason!=='NOT_READY') {
    projected.status='BLOCKED';
    projected.blocked_reason=reason;
  }
  return projected;
}
