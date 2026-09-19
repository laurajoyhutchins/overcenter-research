import type {
  Dependency,
  Obligation,
  Run,
} from './model.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import { canonicalDigest } from './digest.ts';
import { verifiedContentIdentity } from './semantics.ts';

export type RealizationStatus =
  | 'UNREALIZED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export interface Lifecycle {
  status:RealizationStatus;
  run?:Run;
}

const IN_FLIGHT=new Set<RealizationStatus>(['EXECUTING','WAITING','RECOVERY_REQUIRED']);

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

  return canonicalDigest({
    id:work.id,
    packet:work.packet,
    postcondition:work.postcondition,
    ...(work.effect_authority
      ? {effect_authority:work.effect_authority}
      : {}),
    ...(work.result_acceptance
      ? {result_acceptance:work.result_acceptance}
      : {}),
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
    let lifecycle:Lifecycle={status:'UNREALIZED'};

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
