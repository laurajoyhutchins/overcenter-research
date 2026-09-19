import type {
  Dependency,
  Obligation,
  Run,
} from './model.ts';
import type {
  RunRecord,
  Receipt,
  ObligationCatalog,
} from './facts.ts';
import { canonicalDigest } from './digest.ts';
import { verifiedRealizationIdentity } from './semantics.ts';

export type RealizationStatus =
  | 'UNREALIZED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export interface RealizationLifecycle {
  status:RealizationStatus;
  run?:Run;
}

const UNSETTLED_RUN_STATES=new Set<RealizationStatus>(['EXECUTING','WAITING','RECOVERY_REQUIRED']);

function semanticDependencyIdentity(
  catalog:ObligationCatalog,
  edge:Extract<Dependency,{kind:'semantic'}>,
  lifecycles:Map<string,RealizationLifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const upstream=catalog.obligations[edge.upstream];
  if (!upstream) throw new Error(`UNKNOWN_DEPENDENCY:${edge.upstream}`);
  const lifecycle=lifecycles.get(edge.upstream);
  if (lifecycle?.status!=='DONE' || !lifecycle.run) return null;

  if (edge.consumes.kind==='output' && edge.consumes.selector==='verified-content') {
    const identity=verifiedRealizationIdentity(upstream.postcondition);
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
  catalog:ObligationCatalog,
  work:Obligation,
  lifecycles:Map<string,RealizationLifecycle>,
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
    semantic_dependencies:consumed,
  });
}

export function deriveLifecycles(
  catalog:ObligationCatalog,
  runs:Map<string,RunRecord>,
  receiptsByRun:Map<string,Receipt>,
):Map<string,RealizationLifecycle> {
  const lifecycles=new Map<string,RealizationLifecycle>();
  const visiting=new Set<string>();
  const allRuns=[...runs.values()];

  const derive=(id:string):RealizationLifecycle=>{
    const existing=lifecycles.get(id);
    if (existing) return existing;
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    visiting.add(id);

    const work=catalog.obligations[id];
    if (!work) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
    for (const edge of work.dependencies) {
      if (edge.kind==='semantic') derive(edge.upstream);
    }

    const key=obligationKey(catalog,work,lifecycles,receiptsByRun);
    let lifecycle:RealizationLifecycle={status:'UNREALIZED'};

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

  for (const id of Object.keys(catalog.obligations)) derive(id);
  return lifecycles;
}

export function hasUnsettledRun(lifecycles:Map<string,RealizationLifecycle>):boolean {
  return [...lifecycles.values()].some(({status})=>UNSETTLED_RUN_STATES.has(status));
}
