import type {
  Obligation,
  Run,
  Work,
} from './model.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import { dependencyUpstreams } from './graph.ts';
import { staticEffectConflictError } from './admission.ts';
import { obligationKey } from './semantic-identity.ts';

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
  admissibleRealizationRuns?:ReadonlySet<string>;
}

const IN_FLIGHT=new Set<RealizationStatus>([
  'EXECUTING',
  'WAITING',
  'RECOVERY_REQUIRED',
]);

function deriveRealizationRelations(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  admissibleRealizationRuns:ReadonlySet<string>|null,
):{
  lifecycles:Map<string,Lifecycle>;
  semanticKeys:Map<string,string|null>;
} {
  const lifecycles=new Map<string,Lifecycle>();
  const semanticKeys=new Map<string,string|null>();
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
      const done=[...candidates].reverse().find(
        run=>
          receiptsByRun.get(run.id)?.disposition==='DONE'
          && (
            admissibleRealizationRuns===null
            || admissibleRealizationRuns.has(run.id)
          ),
      );

      if (done) {
        lifecycle={status:'DONE',run:done};
      } else {
        const latest=candidates.at(-1);
        if (latest) {
          const receipt=receiptsByRun.get(latest.id);
          if (!receipt) {
            lifecycle={status:'EXECUTING',run:latest};
          } else if (receipt.disposition==='WAITING') {
            lifecycle={status:'WAITING',run:latest};
          } else if (receipt.disposition==='RECOVERY_REQUIRED') {
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
  return {lifecycles,semanticKeys};
}

function claimabilityError(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  semanticKey:string|null,
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
  if (!semanticKey) return 'SEMANTIC_DEPENDENCY_UNRESOLVED';

  // Admission rejects new static conflicts. Keep this defensive projection for
  // older or externally constructed histories so they cannot become executable
  // merely because policy moved earlier.
  return staticEffectConflictError(state,work.id);
}

function projectWork(
  state:State,
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
  admissibleRealizationRuns=null,
}:ProjectProjectionInput):ProjectProjection {
  const {lifecycles,semanticKeys}=deriveRealizationRelations(
    state,
    runs,
    receiptsByRun,
    admissibleRealizationRuns,
  );
  const claimabilityErrors=new Map<string,string|null>();
  const work=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))
    .map(obligation=>{
      const reason=claimabilityError(
        state,
        obligation,
        lifecycles,
        semanticKeys.get(obligation.id)??null,
      );
      claimabilityErrors.set(obligation.id,reason);
      return projectWork(state,obligation,revision,lifecycles,reason);
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
