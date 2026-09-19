import type {
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

export type ProjectExplanation =
  | {
      obligation_id:string;
      status:'READY';
      reason:{
        kind:'claimable';
        semantic_key:string;
        dependencies:string[];
        released_by?:{
          run_id:string;
          disposition:'READY';
          settlement_commit?:string;
        };
      };
    }
  | {
      obligation_id:string;
      status:'BLOCKED';
      reason:
        | {
            kind:'unsatisfied-dependencies';
            dependencies:Array<{
              obligation_id:string;
              status:WorkStatus;
            }>;
          }
        | {
            kind:'semantic-identity-unresolved';
            semantic_dependencies:string[];
          }
        | {
            kind:'static-effect-conflict';
            code:string;
            conflicting_obligations:string[];
          };
    }
  | {
      obligation_id:string;
      status:'EXECUTING';
      reason:{
        kind:'active-run';
        run_id:string;
        semantic_key:string;
        execution_generation:number;
      };
    }
  | {
      obligation_id:string;
      status:'WAITING';
      reason:{
        kind:'waiting-receipt';
        run_id:string;
        receipt_kind:Receipt['kind'];
        settlement_commit?:string;
      };
    }
  | {
      obligation_id:string;
      status:'RECOVERY_REQUIRED';
      reason:{
        kind:'recovery-receipt';
        run_id:string;
        receipt_kind:Receipt['kind'];
        settlement_commit?:string;
      };
    }
  | {
      obligation_id:string;
      status:'DONE';
      reason:{
        kind:'admissible-realization';
        run_id:string;
        semantic_key:string;
        settlement_commit?:string;
        admissibility_basis:
          | 'historical-settlement'
          | 'current-semantic-judgment';
      };
    };

export interface ProjectProjection {
  lifecycles:Map<string,Lifecycle>;
  semanticKeys:Map<string,string|null>;
  explanations:Map<string,ProjectExplanation>;
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

interface RealizationRelations {
  lifecycles:Map<string,Lifecycle>;
  semanticKeys:Map<string,string|null>;
  latestMatchingRuns:Map<string,HistoricalRun>;
}

interface Claimability {
  error:string|null;
  unsatisfiedDependencies:string[];
}

function deriveRealizationRelations(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  admissibleRealizationRuns:ReadonlySet<string>|null,
):RealizationRelations {
  const lifecycles=new Map<string,Lifecycle>();
  const semanticKeys=new Map<string,string|null>();
  const latestMatchingRuns=new Map<string,HistoricalRun>();
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
      if (latest) latestMatchingRuns.set(id,latest);

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
      } else if (latest) {
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

    visiting.delete(id);
    lifecycles.set(id,lifecycle);
    return lifecycle;
  };

  for (const id of Object.keys(state.obligations)) derive(id);
  return {lifecycles,semanticKeys,latestMatchingRuns};
}

function deriveClaimability(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  semanticKey:string|null,
):Claimability {
  const realization=lifecycles.get(work.id)?.status??'UNREALIZED';
  if (realization!=='UNREALIZED') {
    return {error:'NOT_READY',unsatisfiedDependencies:[]};
  }

  const unsatisfiedDependencies=dependencyUpstreams(work)
    .filter(dependency=>lifecycles.get(dependency)?.status!=='DONE');
  if (unsatisfiedDependencies.length>0) {
    return {
      error:'DEPENDENCIES_NOT_DONE',
      unsatisfiedDependencies,
    };
  }
  if (!semanticKey) {
    return {
      error:'SEMANTIC_DEPENDENCY_UNRESOLVED',
      unsatisfiedDependencies:[],
    };
  }

  // Admission rejects new static conflicts. Keep this defensive projection for
  // older or externally constructed histories so they cannot become executable
  // merely because policy moved earlier.
  return {
    error:staticEffectConflictError(state,work.id),
    unsatisfiedDependencies:[],
  };
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

function conflictObligations(code:string):string[] {
  const [kind,...ids]=code.split(':');
  return kind==='UNORDERED_EFFECT_CONFLICT' ? ids : [];
}

function deriveExplanation(
  obligation:Obligation,
  projected:Work,
  claimability:Claimability,
  lifecycles:Map<string,Lifecycle>,
  semanticKeys:Map<string,string|null>,
  latestMatchingRuns:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  statusById:Map<string,WorkStatus>,
  admissibleRealizationRuns:ReadonlySet<string>|null,
):ProjectExplanation {
  const lifecycle=lifecycles.get(obligation.id)??{status:'UNREALIZED' as const};
  const semanticKey=semanticKeys.get(obligation.id)??null;

  if (projected.status==='DONE') {
    if (!lifecycle.run || !semanticKey) {
      throw new Error(`EXPLANATION_INCOMPLETE_DONE:${obligation.id}`);
    }
    const receipt=receiptsByRun.get(lifecycle.run.id);
    return {
      obligation_id:obligation.id,
      status:'DONE',
      reason:{
        kind:'admissible-realization',
        run_id:lifecycle.run.id,
        semantic_key:semanticKey,
        ...(receipt?.settlement_commit
          ? {settlement_commit:receipt.settlement_commit}
          : {}),
        admissibility_basis:admissibleRealizationRuns===null
          ? 'historical-settlement'
          : 'current-semantic-judgment',
      },
    };
  }

  if (projected.status==='EXECUTING') {
    if (!lifecycle.run || !semanticKey) {
      throw new Error(`EXPLANATION_INCOMPLETE_EXECUTING:${obligation.id}`);
    }
    return {
      obligation_id:obligation.id,
      status:'EXECUTING',
      reason:{
        kind:'active-run',
        run_id:lifecycle.run.id,
        semantic_key:semanticKey,
        execution_generation:lifecycle.run.execution_generation,
      },
    };
  }

  if (
    projected.status==='WAITING'
    || projected.status==='RECOVERY_REQUIRED'
  ) {
    if (!lifecycle.run) {
      throw new Error(`EXPLANATION_INCOMPLETE_RECEIPT:${obligation.id}`);
    }
    const receipt=receiptsByRun.get(lifecycle.run.id);
    if (!receipt) {
      throw new Error(`EXPLANATION_RECEIPT_MISSING:${obligation.id}`);
    }
    const base={
      run_id:lifecycle.run.id,
      receipt_kind:receipt.kind,
      ...(receipt.settlement_commit
        ? {settlement_commit:receipt.settlement_commit}
        : {}),
    };
    return projected.status==='WAITING'
      ? {
          obligation_id:obligation.id,
          status:'WAITING',
          reason:{kind:'waiting-receipt',...base},
        }
      : {
          obligation_id:obligation.id,
          status:'RECOVERY_REQUIRED',
          reason:{kind:'recovery-receipt',...base},
        };
  }

  if (projected.status==='BLOCKED') {
    if (claimability.error==='DEPENDENCIES_NOT_DONE') {
      return {
        obligation_id:obligation.id,
        status:'BLOCKED',
        reason:{
          kind:'unsatisfied-dependencies',
          dependencies:claimability.unsatisfiedDependencies.map(id=>({
            obligation_id:id,
            status:statusById.get(id)??'BLOCKED',
          })),
        },
      };
    }
    if (claimability.error==='SEMANTIC_DEPENDENCY_UNRESOLVED') {
      return {
        obligation_id:obligation.id,
        status:'BLOCKED',
        reason:{
          kind:'semantic-identity-unresolved',
          semantic_dependencies:obligation.dependencies
            .filter(edge=>edge.kind==='semantic')
            .map(edge=>edge.upstream)
            .sort(),
        },
      };
    }
    if (!claimability.error) {
      throw new Error(`EXPLANATION_BLOCKED_WITHOUT_REASON:${obligation.id}`);
    }
    return {
      obligation_id:obligation.id,
      status:'BLOCKED',
      reason:{
        kind:'static-effect-conflict',
        code:claimability.error,
        conflicting_obligations:conflictObligations(claimability.error),
      },
    };
  }

  if (!semanticKey) {
    throw new Error(`EXPLANATION_READY_WITHOUT_SEMANTIC_KEY:${obligation.id}`);
  }
  const latest=latestMatchingRuns.get(obligation.id);
  const receipt=latest ? receiptsByRun.get(latest.id) : undefined;
  return {
    obligation_id:obligation.id,
    status:'READY',
    reason:{
      kind:'claimable',
      semantic_key:semanticKey,
      dependencies:dependencyUpstreams(obligation),
      ...(latest && receipt?.disposition==='READY'
        ? {
            released_by:{
              run_id:latest.id,
              disposition:'READY' as const,
              ...(receipt.settlement_commit
                ? {settlement_commit:receipt.settlement_commit}
                : {}),
            },
          }
        : {}),
    },
  };
}

export function deriveProjectProjection({
  state,
  runs,
  receiptsByRun,
  revision,
  admissibleRealizationRuns=null,
}:ProjectProjectionInput):ProjectProjection {
  const {
    lifecycles,
    semanticKeys,
    latestMatchingRuns,
  }=deriveRealizationRelations(
    state,
    runs,
    receiptsByRun,
    admissibleRealizationRuns,
  );
  const claimabilityErrors=new Map<string,string|null>();
  const claimabilityById=new Map<string,Claimability>();
  const obligations=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id));
  const work=obligations.map(obligation=>{
    const claimability=deriveClaimability(
      state,
      obligation,
      lifecycles,
      semanticKeys.get(obligation.id)??null,
    );
    claimabilityById.set(obligation.id,claimability);
    claimabilityErrors.set(obligation.id,claimability.error);
    return projectWork(
      obligation,
      revision,
      lifecycles,
      claimability.error,
    );
  });

  const statusById=new Map(
    work.map(candidate=>[candidate.id,candidate.status]),
  );
  const workById=new Map(
    work.map(candidate=>[candidate.id,candidate]),
  );
  const explanations=new Map<string,ProjectExplanation>();
  for (const obligation of obligations) {
    const projected=workById.get(obligation.id);
    const claimability=claimabilityById.get(obligation.id);
    if (!projected || !claimability) {
      throw new Error(`EXPLANATION_INPUT_MISSING:${obligation.id}`);
    }
    explanations.set(
      obligation.id,
      deriveExplanation(
        obligation,
        projected,
        claimability,
        lifecycles,
        semanticKeys,
        latestMatchingRuns,
        receiptsByRun,
        statusById,
        admissibleRealizationRuns,
      ),
    );
  }

  const readyWork=work.find(
    candidate=>claimabilityErrors.get(candidate.id)===null,
  )??null;

  return {
    lifecycles,
    semanticKeys,
    explanations,
    work,
    claimabilityErrors,
    readyWork,
  };
}

export function explainProjectWork(
  project:ProjectProjection,
  obligationId:string,
):ProjectExplanation {
  const explanation=project.explanations.get(obligationId);
  if (!explanation) throw new Error(`UNKNOWN_OBLIGATION:${obligationId}`);
  return structuredClone(explanation);
}

export function hasInFlight(project:ProjectProjection):boolean {
  return [...project.lifecycles.values()]
    .some(({status})=>IN_FLIGHT.has(status));
}
