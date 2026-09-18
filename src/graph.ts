import { createHash } from 'node:crypto';
import type {
  Dependency,
  LifecycleStatus,
  Obligation,
  Run,
  Work,
  WorkStatus,
} from './model.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import {
  effectSemantics,
  verifiedContentIdentity,
} from './semantics.ts';

export interface Lifecycle {
  status:LifecycleStatus;
  run?:Run;
}

const IN_FLIGHT=new Set<WorkStatus>(['EXECUTING','WAITING','RECOVERY_REQUIRED']);

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function digest(value:unknown):string {
  const canonical=(input:unknown):unknown=>{
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input==='object') {
      return Object.fromEntries(
        Object.entries(input as Record<string,unknown>)
          .sort(([a],[b])=>a.localeCompare(b))
          .map(([key,item])=>[key,canonical(item)]),
      );
    }
    return input;
  };
  return sha256(JSON.stringify(canonical(value)));
}

export function dependencyUpstreams(obligation:Obligation):string[] {
  return [...new Set(obligation.dependencies.map(edge=>edge.upstream))];
}

export function withObligation(
  state:State,
  obligation:Obligation,
  definitionCommit:string,
):State {
  return {
    obligations:{
      ...structuredClone(state.obligations),
      [obligation.id]:structuredClone(obligation),
    },
    definition_commits:{
      ...state.definition_commits,
      [obligation.id]:definitionCommit,
    },
  };
}

export function validateGraph(state:State):void {
  for (const obligation of Object.values(state.obligations)) {
    for (const dependency of dependencyUpstreams(obligation)) {
      if (!state.obligations[dependency]) {
        throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${dependency}`);
      }
    }
  }

  const visiting=new Set<string>();
  const visited=new Set<string>();
  const visit=(id:string):void=>{
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencyUpstreams(state.obligations[id])) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(state.obligations)) visit(id);
}

function semanticDependencyIdentity(
  state:State,
  edge:Extract<Dependency,{kind:'semantic'}>,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const upstream=state.obligations[edge.upstream];
  if (!upstream) throw new Error(`UNKNOWN_DEPENDENCY:${edge.upstream}`);
  const lifecycle=lifecycles.get(edge.upstream);
  if (lifecycle?.status!=='DONE' || !lifecycle.run) return null;

  if (edge.consumes.kind==='output' && edge.consumes.selector==='verified-content') {
    const identity=verifiedContentIdentity(upstream.postcondition);
    if (identity) return identity;
  }

  if (edge.consumes.kind==='evidence' && edge.consumes.selector==='settlement-receipt') {
    const receipt=receiptsByRun.get(lifecycle.run.id);
    if (receipt?.disposition!=='DONE' || !receipt.settlement_commit) return null;
    return `settlement:${receipt.settlement_commit}`;
  }

  throw new Error(
    `UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`,
  );
}

export function obligationKey(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const semantic=work.dependencies
    .filter((edge):edge is Extract<Dependency,{kind:'semantic'}>=>edge.kind==='semantic');

  const consumed:Array<{
    consumes:Extract<Dependency,{kind:'semantic'}>['consumes'];
    identity:string;
  }>=[];
  for (const edge of semantic) {
    const identity=semanticDependencyIdentity(state,edge,lifecycles,receiptsByRun);
    if (!identity) return null;
    consumed.push({
      consumes:structuredClone(edge.consumes),
      identity,
    });
  }
  consumed.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return digest({
    id:work.id,
    packet:work.packet,
    postcondition:work.postcondition,
    semantic_dependencies:consumed,
  });
}

export function deriveLifecycles(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
):Map<string,Lifecycle> {
  const lifecycles=new Map<string,Lifecycle>();
  const visiting=new Set<string>();
  const allRuns=[...runs.values()];

  const derive=(id:string):Lifecycle=>{
    const existing=lifecycles.get(id);
    if (existing) return existing;
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    visiting.add(id);

    const work=state.obligations[id];
    if (!work) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
    for (const edge of work.dependencies) {
      if (edge.kind==='semantic') derive(edge.upstream);
    }

    const key=obligationKey(state,work,lifecycles,receiptsByRun);
    let lifecycle:Lifecycle={status:'READY'};

    if (key) {
      const candidates=allRuns.filter(
        run=>run.obligation_id===id && run.obligation_key===key,
      );
      const done=[...candidates].reverse().find(
        run=>receiptsByRun.get(run.id)?.disposition==='DONE',
      );
      if (done) {
        lifecycle={status:'DONE',run:done};
      } else {
        const latest=candidates.at(-1);
        if (latest) {
          const receipt=receiptsByRun.get(latest.id);
          if (!receipt) lifecycle={status:'EXECUTING',run:latest};
          else if (receipt.disposition==='WAITING') lifecycle={status:'WAITING',run:latest};
          else if (receipt.disposition==='RECOVERY_REQUIRED') {
            lifecycle={status:'RECOVERY_REQUIRED',run:latest};
          }
        }
      }
    }

    visiting.delete(id);
    lifecycles.set(id,lifecycle);
    return lifecycle;
  };

  for (const id of Object.keys(state.obligations)) derive(id);
  return lifecycles;
}

export function hasInFlight(lifecycles:Map<string,Lifecycle>):boolean {
  return [...lifecycles.values()].some(({status})=>IN_FLIGHT.has(status));
}

function dependsOn(
  state:State,
  fromId:string,
  targetId:string,
  seen=new Set<string>(),
):boolean {
  if (fromId===targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const work=state.obligations[fromId];
  if (!work) return false;
  return dependencyUpstreams(work)
    .some(dependency=>dependency===targetId || dependsOn(state,dependency,targetId,seen));
}

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
