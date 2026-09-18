import type {
  LifecycleStatus,
  Obligation,
  Work,
} from './model.ts';
import type { State } from './facts.ts';
import {
  dependencyUpstreams,
  dependsOn,
} from './graph.ts';
import type { Lifecycle } from './lifecycle.ts';
import { effectSemantics } from './semantics.ts';

export function claimabilityError(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
):string|null {
  if (lifecycles.get(work.id)?.status!=='READY') return 'NOT_READY';

  const done=new Set(
    Object.values(state.obligations)
      .filter(candidate=>lifecycles.get(candidate.id)?.status==='DONE')
      .map(candidate=>candidate.id),
  );
  if (!dependencyUpstreams(work).every(dependency=>done.has(dependency))) {
    return 'DEPENDENCIES_NOT_DONE';
  }

  const semantics=effectSemantics(work.postcondition);
  if (!semantics) return null;

  for (const other of Object.values(state.obligations)) {
    if (other.id===work.id) continue;
    const otherSemantics=effectSemantics(other.postcondition);
    if (!otherSemantics || otherSemantics.resource!==semantics.resource) continue;

    const sameDesired=otherSemantics.desired===semantics.desired;
    if (
      sameDesired
      && semantics.sameDesiredCommutes
      && otherSemantics.sameDesiredCommutes
    ) continue;

    const ordered=dependsOn(state,work.id,other.id)
      || dependsOn(state,other.id,work.id);
    if (!ordered) return `UNORDERED_EFFECT_CONFLICT:${work.id}:${other.id}`;
  }
  return null;
}

export function projectWork(
  state:State,
  work:Obligation,
  revision:string,
  lifecycles:Map<string,Lifecycle>,
):Work {
  const lifecycle=lifecycles.get(work.id)??{status:'READY' as LifecycleStatus};
  const projected={
    ...structuredClone(work),
    status:lifecycle.status,
    revision,
    ...(lifecycle.run
      ? {run_id:lifecycle.run.id,claimed_revision:lifecycle.run.claimed_revision}
      : {}),
  } as Work;

  if (projected.status!=='READY') return projected;

  const reason=claimabilityError(state,work,lifecycles);
  if (reason && reason!=='NOT_READY') {
    projected.status='BLOCKED';
    projected.blocked_reason=reason;
  }
  return projected;
}
