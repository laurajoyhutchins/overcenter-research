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
import {
  declaredRealizationContract,
  reusableRealization,
  type RealizationContract,
  type SemanticDependencyIdentity,
  type VerifiedRealizationFact,
} from './realization.ts';

export type RealizationStatus =
  | 'UNREALIZED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export interface Lifecycle {
  status:RealizationStatus;
  run?:Run;
  realization?:VerifiedRealizationFact;
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
  if (lifecycle?.status!=='DONE') return null;

  if (edge.consumes.kind==='output' && edge.consumes.selector==='verified-content') {
    if (lifecycle.realization) return lifecycle.realization.realization_identity;
    const identity=verifiedContentIdentity(upstream.postcondition);
    if (identity) return identity;
  }

  if (edge.consumes.kind==='evidence' && edge.consumes.selector==='settlement-receipt') {
    if (!lifecycle.run) return null;
    const receipt=receiptsByRun.get(lifecycle.run.id);
    if (receipt?.disposition!=='DONE' || !receipt.settlement_commit) return null;
    return `settlement:${receipt.settlement_commit}`;
  }

  throw new Error(
    `UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`,
  );
}

function consumedSemanticDependencies(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):Array<{
  consumes:Extract<Dependency,{kind:'semantic'}>['consumes'];
  identity:string;
}>|null {
  const consumed:Array<{
    consumes:Extract<Dependency,{kind:'semantic'}>['consumes'];
    identity:string;
  }>=[];
  for (const edge of work.dependencies) {
    if (edge.kind!=='semantic') continue;
    const identity=semanticDependencyIdentity(state,edge,lifecycles,receiptsByRun);
    if (!identity) return null;
    consumed.push({
      consumes:structuredClone(edge.consumes),
      identity,
    });
  }
  consumed.sort((a,b)=>canonicalDigest(a).localeCompare(canonicalDigest(b)));
  return consumed;
}

export function obligationKey(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const consumed=consumedSemanticDependencies(state,work,lifecycles,receiptsByRun);
  if (!consumed) return null;

  return canonicalDigest({
    id:work.id,
    packet:work.packet,
    postcondition:work.postcondition,
    realization:work.realization??null,
    semantic_dependencies:consumed,
  });
}

export function obligationRealizationContract(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):RealizationContract|null {
  if (!work.realization) return null;
  const consumed=consumedSemanticDependencies(state,work,lifecycles,receiptsByRun);
  if (!consumed) return null;
  const semanticDependencies:SemanticDependencyIdentity[]=consumed.map(item=>({
    selector:`${item.consumes.kind}:${item.consumes.selector}`,
    identity:item.identity,
  }));
  return declaredRealizationContract(
    work.packet,
    semanticDependencies,
    work.realization,
  );
}

export function deriveLifecycles(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  realizations:Iterable<VerifiedRealizationFact>=[],
):Map<string,Lifecycle> {
  const lifecycles=new Map<string,Lifecycle>();
  const visiting=new Set<string>();
  const allRuns=[...runs.values()];
  const reusableFacts=[...realizations];

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
      const currentDefinition=state.definition_commits[id];
      const candidates=allRuns.filter(
        run=>run.obligation_id===id
          && run.obligation_key===key
          && run.definition_commit===currentDefinition,
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

    if (lifecycle.status==='UNREALIZED') {
      const contract=obligationRealizationContract(
        state,
        work,
        lifecycles,
        receiptsByRun,
      );
      if (contract) {
        const reuse=reusableRealization(contract,reusableFacts);
        if (reuse.satisfied) {
          lifecycle={
            status:'DONE',
            realization:reuse.realization,
          };
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
