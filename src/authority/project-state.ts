import type {
  Obligation,
  Run,
  Work,
} from '../model.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import { dependencyUpstreams } from '../graph/topology.ts';
import {
  buildStaticEffectIndex,
  staticEffectConflict,
  type StaticEffectIndex,
} from './admission.ts';
import { obligationKey } from '../graph/identity.ts';
import type { CurrentRealizationJudgment } from './realization-reuse.ts';

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

export interface ProjectProjection {
  lifecycles:Map<string,Lifecycle>;
  semanticKeys:Map<string,string|null>;
  work:Work[];
  claimabilityErrors:Map<string,string|null>;
  readyWork:Work|null;
}

export interface ProjectProjectionInput {
  state:State;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  revision:string;
  currentRealizationJudgments?:ReadonlyMap<
    string,
    CurrentRealizationJudgment
  >;
}

const IN_FLIGHT=new Set<RealizationStatus>([
  'EXECUTING',
  'WAITING',
  'RECOVERY_REQUIRED',
]);

interface RealizationJudgmentRelation {
  run:HistoricalRun;
  judgment:CurrentRealizationJudgment;
}

interface RealizationRelations {
  lifecycles:Map<string,Lifecycle>;
  semanticKeys:Map<string,string|null>;
  indeterminateRealizations:Map<string,RealizationJudgmentRelation>;
}

interface Claimability {
  error:string|null;
}

function deriveRealizationRelations(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  currentRealizationJudgments:ReadonlyMap<
    string,
    CurrentRealizationJudgment
  >|null,
):RealizationRelations {
  const lifecycles=new Map<string,Lifecycle>();
  const semanticKeys=new Map<string,string|null>();
  const indeterminateRealizations=new Map<string,RealizationJudgmentRelation>();
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
    semanticKeys.set(id,key);
    let lifecycle:Lifecycle={status:'UNREALIZED'};

    if (key) {
      const candidates=allRuns.filter(
        run=>run.obligation_id===id && run.obligation_key===key,
      );
      const latest=candidates.at(-1);
      const doneCandidates=[...candidates].reverse().filter(
        run=>receiptsByRun.get(run.id)?.disposition==='DONE',
      );
      let done:HistoricalRun|undefined;
      if (currentRealizationJudgments===null) {
        done=doneCandidates[0];
      } else {
        for (const run of doneCandidates) {
          const judgment=currentRealizationJudgments.get(run.id)??{
            state:'indeterminate' as const,
            reason:'CURRENT_REALIZATION_JUDGMENT_MISSING',
          };
          if (judgment.state==='admissible') {
            done=run;
            break;
          }
          if (
            judgment.state==='indeterminate'
            && !indeterminateRealizations.has(id)
          ) {
            indeterminateRealizations.set(id,{run,judgment});
          }
        }
      }

      if (done) {
        lifecycle={status:'DONE',run:done};
      } else if (latest) {
        const receipt=receiptsByRun.get(latest.id);
        if (!receipt) {
          lifecycle={status:'EXECUTING',run:latest};
        } else if (receipt.disposition==='WAITING') {
          lifecycle={
            status:
              typeof receipt.execution_generation==='number'
              && latest.execution_generation>receipt.execution_generation
                ? 'EXECUTING'
                : 'WAITING',
            run:latest,
          };
        } else if (receipt.disposition==='RECOVERY_REQUIRED') {
          lifecycle={status:'RECOVERY_REQUIRED',run:latest};
        }
      }
    }

    visiting.delete(id);
    lifecycles.set(id,lifecycle);
    return lifecycle;
  };

  for (const id of Object.keys(state.obligations)) derive(id);
  return {
    lifecycles,
    semanticKeys,
    indeterminateRealizations,
  };
}

function deriveClaimability(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  semanticKey:string|null,
  indeterminateRealization:RealizationJudgmentRelation|null,
  staticEffectIndex:StaticEffectIndex,
):Claimability {
  const realization=lifecycles.get(work.id)?.status??'UNREALIZED';
  if (realization!=='UNREALIZED') return {error:'NOT_READY'};
  if (indeterminateRealization) {
    return {error:'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE'};
  }
  if (dependencyUpstreams(work).some(
    dependency=>lifecycles.get(dependency)?.status!=='DONE',
  )) return {error:'DEPENDENCIES_NOT_DONE'};
  if (!semanticKey) return {error:'SEMANTIC_DEPENDENCY_UNRESOLVED'};

  // Admission rejects new static conflicts. Keep this defensive projection for
  // older or externally constructed histories so they cannot become executable
  // merely because policy moved earlier.
  return {error:staticEffectConflict(state,work.id,staticEffectIndex)?.code??null};
}

function projectWork(
  work:Obligation,
  revision:string,
  lifecycles:Map<string,Lifecycle>,
  reason:string|null,
):Work {
  const lifecycle=lifecycles.get(work.id)??{status:'UNREALIZED' as const};
  const projected={
    ...structuredClone(work),
    status:lifecycle.status==='UNREALIZED' ? 'READY' : lifecycle.status,
    revision,
    ...(lifecycle.run
      ? {
          run_id:lifecycle.run.id,
          claimed_revision:lifecycle.run.claimed_revision,
          execution_generation:lifecycle.run.execution_generation,
        }
      : {}),
  } as Work;

  if (
    lifecycle.status==='UNREALIZED'
    && reason
    && reason!=='NOT_READY'
  ) {
    projected.status='BLOCKED';
    projected.blocked_reason=reason;
  }

  return projected;
}

export function deriveProjectProjection({
  state,
  runs,
  receiptsByRun,
  revision,
  currentRealizationJudgments=null,
}:ProjectProjectionInput):ProjectProjection {
  const {
    lifecycles,
    semanticKeys,
    indeterminateRealizations,
  }=deriveRealizationRelations(
    state,
    runs,
    receiptsByRun,
    currentRealizationJudgments,
  );
  const staticEffectIndex=buildStaticEffectIndex(state);
  const claimabilityErrors=new Map<string,string|null>();
  const obligations=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id));
  const work=obligations.map(obligation=>{
    const claimability=deriveClaimability(
      state,
      obligation,
      lifecycles,
      semanticKeys.get(obligation.id)??null,
      indeterminateRealizations.get(obligation.id)??null,
      staticEffectIndex,
    );
    claimabilityErrors.set(obligation.id,claimability.error);
    return projectWork(
      obligation,
      revision,
      lifecycles,
      claimability.error,
    );
  });

  const readyWork=work.find(
    candidate=>claimabilityErrors.get(candidate.id)===null,
  )??null;

  return {
    lifecycles,
    semanticKeys,
    work,
    claimabilityErrors,
    readyWork,
  };
}

export function hasInFlight(project:ProjectProjection):boolean {
  return [...project.lifecycles.values()]
    .some(({status})=>IN_FLIGHT.has(status));
}
