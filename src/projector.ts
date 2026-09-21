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
import {
  buildStaticEffectIndex,
  staticEffectConflict,
  type StaticEffectConflict,
  type StaticEffectIndex,
} from './admission.ts';
import { obligationKey } from './semantic-identity.ts';
import type { CurrentRealizationJudgment } from './realization-admissibility.ts';

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
        dependencies:Array<{
          obligation_id:string;
          status:'DONE';
        }>;
        released_by?:{
          run_id:string;
          disposition:'READY';
          settlement_commit?:string;
        };
        rejected_realization?:{
          run_id:string;
          disposition:'DONE';
          reason:'not-currently-admissible';
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
          }
        | {
            kind:'current-realization-indeterminate';
            run_id:string;
            reason:string;
            settlement_commit?:string;
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
  latestMatchingRuns:Map<string,HistoricalRun>;
  rejectedRealizations:Map<string,RealizationJudgmentRelation>;
  indeterminateRealizations:Map<string,RealizationJudgmentRelation>;
}

interface Claimability {
  error:string|null;
  unsatisfiedDependencies:string[];
  staticConflict:StaticEffectConflict|null;
  indeterminateRealization:RealizationJudgmentRelation|null;
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
  const latestMatchingRuns=new Map<string,HistoricalRun>();
  const rejectedRealizations=new Map<string,RealizationJudgmentRelation>();
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
      if (latest) latestMatchingRuns.set(id,latest);

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
          if (
            judgment.state==='rejected'
            && !rejectedRealizations.has(id)
          ) {
            rejectedRealizations.set(id,{run,judgment});
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
  return {
    lifecycles,
    semanticKeys,
    latestMatchingRuns,
    rejectedRealizations,
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
  if (realization!=='UNREALIZED') {
    return {
      error:'NOT_READY',
      unsatisfiedDependencies:[],
      staticConflict:null,
      indeterminateRealization:null,
    };
  }

  if (indeterminateRealization) {
    return {
      error:'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE',
      unsatisfiedDependencies:[],
      staticConflict:null,
      indeterminateRealization,
    };
  }

  const unsatisfiedDependencies=dependencyUpstreams(work)
    .filter(dependency=>lifecycles.get(dependency)?.status!=='DONE');
  if (unsatisfiedDependencies.length>0) {
    return {
      error:'DEPENDENCIES_NOT_DONE',
      unsatisfiedDependencies,
      staticConflict:null,
      indeterminateRealization:null,
    };
  }
  if (!semanticKey) {
    return {
      error:'SEMANTIC_DEPENDENCY_UNRESOLVED',
      unsatisfiedDependencies:[],
      staticConflict:null,
      indeterminateRealization:null,
    };
  }

  // Admission rejects new static conflicts. Keep this defensive projection for
  // older or externally constructed histories so they cannot become executable
  // merely because policy moved earlier.
  const conflict=staticEffectConflict(state,work.id,staticEffectIndex);
  return {
    error:conflict?.code??null,
    unsatisfiedDependencies:[],
    staticConflict:conflict,
    indeterminateRealization:null,
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

function requiredStatus(
  statusById:Map<string,WorkStatus>,
  obligationId:string,
):WorkStatus {
  const status=statusById.get(obligationId);
  if (!status) throw new Error(`EXPLANATION_DEPENDENCY_STATUS_MISSING:${obligationId}`);
  return status;
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
  currentRealizationJudgments:ReadonlyMap<
    string,
    CurrentRealizationJudgment
  >|null,
  rejectedRealizations:Map<string,RealizationJudgmentRelation>,
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
        admissibility_basis:currentRealizationJudgments===null
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
    if (
      claimability.error==='CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE'
      && claimability.indeterminateRealization
    ) {
      const {run,judgment}=claimability.indeterminateRealization;
      const receipt=receiptsByRun.get(run.id);
      return {
        obligation_id:obligation.id,
        status:'BLOCKED',
        reason:{
          kind:'current-realization-indeterminate',
          run_id:run.id,
          reason:judgment.reason,
          ...(receipt?.settlement_commit
            ? {settlement_commit:receipt.settlement_commit}
            : {}),
        },
      };
    }
    if (claimability.error==='DEPENDENCIES_NOT_DONE') {
      return {
        obligation_id:obligation.id,
        status:'BLOCKED',
        reason:{
          kind:'unsatisfied-dependencies',
          dependencies:claimability.unsatisfiedDependencies.map(id=>({
            obligation_id:id,
            status:requiredStatus(statusById,id),
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
    const conflict=claimability.staticConflict;
    if (!conflict) {
      throw new Error(
        `EXPLANATION_UNSUPPORTED_BLOCK_REASON:${obligation.id}:${claimability.error}`,
      );
    }
    return {
      obligation_id:obligation.id,
      status:'BLOCKED',
      reason:{
        kind:'static-effect-conflict',
        code:claimability.error,
        conflicting_obligations:[conflict.left,conflict.right],
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
      dependencies:dependencyUpstreams(obligation).map(id=>({
        obligation_id:id,
        status:'DONE' as const,
      })),
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
      ...(()=>{
        const rejected=rejectedRealizations.get(obligation.id);
        if (!rejected) return {};
        const rejectedReceipt=receiptsByRun.get(rejected.run.id);
        return {
          rejected_realization:{
            run_id:rejected.run.id,
            disposition:'DONE' as const,
            reason:'not-currently-admissible' as const,
            ...(rejectedReceipt?.settlement_commit
              ? {settlement_commit:rejectedReceipt.settlement_commit}
              : {}),
          },
        };
      })(),
    },
  };
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
    latestMatchingRuns,
    rejectedRealizations,
    indeterminateRealizations,
  }=deriveRealizationRelations(
    state,
    runs,
    receiptsByRun,
    currentRealizationJudgments,
  );
  const staticEffectIndex=buildStaticEffectIndex(state);
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
        indeterminateRealizations.get(obligation.id)??null,
        staticEffectIndex,
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
        currentRealizationJudgments,
        rejectedRealizations,
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
