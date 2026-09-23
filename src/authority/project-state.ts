import type {
  Obligation,
  Run,
  Work,
  WorkStatus,
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
  readyWork:Work|null;
}

export interface ProjectExplanation {
  obligation_id:string;
  status:WorkStatus;
  reason:{kind:string;[key:string]:unknown};
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
    return projectWork(
      obligation,
      revision,
      lifecycles,
      claimability.error,
    );
  });

  const readyWork=work.find(candidate=>candidate.status==='READY')??null;

  return {
    lifecycles,
    semanticKeys,
    work,
    readyWork,
  };
}


export function explainProjectWork(
  project:ProjectProjection,
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  obligationId:string,
  currentRealizationJudgments:ReadonlyMap<string,CurrentRealizationJudgment>|null=null,
):ProjectExplanation {
  const work=project.work.find(candidate=>candidate.id===obligationId);
  if (!work) throw new Error(`UNKNOWN_OBLIGATION:${obligationId}`);
  const lifecycle=project.lifecycles.get(obligationId)??{status:'UNREALIZED' as const};
  const semanticKey=project.semanticKeys.get(obligationId)??null;
  const receipt=lifecycle.run?receiptsByRun.get(lifecycle.run.id):undefined;
  const base={obligation_id:obligationId,status:work.status};

  if (work.status==='DONE') {
    if (!lifecycle.run || !semanticKey) throw new Error(`EXPLANATION_INCOMPLETE_DONE:${obligationId}`);
    return {...base,reason:{
      kind:'admissible-realization',
      run_id:lifecycle.run.id,
      semantic_key:semanticKey,
      ...(receipt?.settlement_commit?{settlement_commit:receipt.settlement_commit}:{}),
      admissibility_basis:currentRealizationJudgments===null
        ? 'historical-settlement'
        : 'current-semantic-judgment',
    }};
  }
  if (work.status==='EXECUTING') {
    if (!lifecycle.run || !semanticKey) throw new Error(`EXPLANATION_INCOMPLETE_EXECUTING:${obligationId}`);
    return {...base,reason:{
      kind:'active-run',
      run_id:lifecycle.run.id,
      semantic_key:semanticKey,
      execution_generation:lifecycle.run.execution_generation,
    }};
  }
  if (work.status==='WAITING' || work.status==='RECOVERY_REQUIRED') {
    if (!lifecycle.run || !receipt) throw new Error(`EXPLANATION_RECEIPT_MISSING:${obligationId}`);
    return {...base,reason:{
      kind:work.status==='WAITING'?'waiting-receipt':'recovery-receipt',
      run_id:lifecycle.run.id,
      receipt_kind:receipt.kind,
      ...(receipt.settlement_commit?{settlement_commit:receipt.settlement_commit}:{}),
    }};
  }
  if (work.status==='BLOCKED') {
    if (work.blocked_reason==='DEPENDENCIES_NOT_DONE') {
      const status=new Map(project.work.map(candidate=>[candidate.id,candidate.status]));
      return {...base,reason:{
        kind:'unsatisfied-dependencies',
        dependencies:dependencyUpstreams(work)
          .filter(id=>status.get(id)!=='DONE')
          .map(id=>({obligation_id:id,status:status.get(id)})),
      }};
    }
    if (work.blocked_reason==='SEMANTIC_DEPENDENCY_UNRESOLVED') {
      return {...base,reason:{
        kind:'semantic-identity-unresolved',
        semantic_dependencies:work.dependencies
          .filter(edge=>edge.kind==='semantic')
          .map(edge=>edge.upstream)
          .sort(),
      }};
    }
    if (work.blocked_reason==='CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE') {
      const run=[...runs.values()].reverse().find(candidate=>
        candidate.obligation_id===obligationId
        && candidate.obligation_key===semanticKey
        && receiptsByRun.get(candidate.id)?.disposition==='DONE'
        && currentRealizationJudgments?.get(candidate.id)?.state==='indeterminate'
      );
      const judgment=run?currentRealizationJudgments?.get(run.id):undefined;
      if (run && judgment?.state==='indeterminate') return {...base,reason:{
        kind:'current-realization-indeterminate',
        run_id:run.id,
        reason:judgment.reason,
        ...(receiptsByRun.get(run.id)?.settlement_commit
          ? {settlement_commit:receiptsByRun.get(run.id)!.settlement_commit}
          : {}),
      }};
    }
    const conflict=staticEffectConflict(state,obligationId,buildStaticEffectIndex(state));
    return {...base,reason:{
      kind:'static-effect-conflict',
      code:work.blocked_reason??'NOT_READY',
      conflicting_obligations:conflict?[conflict.left,conflict.right]:[],
    }};
  }

  if (!semanticKey) throw new Error(`EXPLANATION_READY_WITHOUT_SEMANTIC_KEY:${obligationId}`);
  const matching=[...runs.values()].filter(
    run=>run.obligation_id===obligationId && run.obligation_key===semanticKey,
  );
  const latest=matching.at(-1);
  const latestReceipt=latest?receiptsByRun.get(latest.id):undefined;
  const rejected=[...matching].reverse().find(
    run=>receiptsByRun.get(run.id)?.disposition==='DONE'
      && currentRealizationJudgments?.get(run.id)?.state==='rejected',
  );
  return {...base,reason:{
    kind:'claimable',
    semantic_key:semanticKey,
    dependencies:dependencyUpstreams(work).map(id=>({obligation_id:id,status:'DONE'})),
    ...(latest && latestReceipt?.disposition==='READY'?{released_by:{
      run_id:latest.id,
      disposition:'READY',
      ...(latestReceipt.settlement_commit?{settlement_commit:latestReceipt.settlement_commit}:{}),
    }}:{}),
    ...(rejected?{rejected_realization:{
      run_id:rejected.id,
      disposition:'DONE',
      reason:'not-currently-admissible',
      ...(receiptsByRun.get(rejected.id)?.settlement_commit
        ? {settlement_commit:receiptsByRun.get(rejected.id)!.settlement_commit}
        : {}),
    }}:{}),
  }};
}

export function hasInFlight(project:ProjectProjection):boolean {
  return [...project.lifecycles.values()]
    .some(({status})=>IN_FLIGHT.has(status));
}
