import { createHash } from 'node:crypto';
import type {
  Data,
  Dependency,
  Disposition,
  LifecycleStatus,
  Obligation,
  Observation,
  Postcondition,
  Run,
  Work,
  WorkStatus,
} from './model.ts';
import { observationVerified, validatePostcondition } from './observation.ts';
import { githubStatusContextKey } from './providers/github-status.ts';

export const OBLIGATION_SCHEMA='overcenter-git-obligation-v3' as const;
export const CLAIM_SCHEMA='overcenter-git-claim-v2' as const;
export const RECEIPT_SCHEMA='overcenter-git-receipt-v3' as const;

export interface ObligationInput {
  id:string;
  dependencies?:Dependency[];
  packet?:Data;
  postcondition:Postcondition;
}

export interface State {
  obligations:Record<string,Obligation>;
  definition_commits:Record<string,string>;
}

export type ObligationFact =
  | {
      schema:typeof OBLIGATION_SCHEMA;
      kind:'defined';
      obligation:Obligation;
    }
  | {
      schema:typeof OBLIGATION_SCHEMA;
      kind:'amended';
      obligation:Obligation;
      previous_definition_commit:string;
    };

export interface ClaimFact {
  schema:typeof CLAIM_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  obligation_key:string;
}

export type ReceiptKind='observation'|'judgment-required'|'execution-terminated';

export interface ReceiptFact {
  schema:typeof RECEIPT_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  claim_commit:string;
  kind:ReceiptKind;
  observed:Observation|null;
  diagnostic?:Data;
  settled_at:string;
}

export interface Receipt extends ReceiptFact {
  disposition:Disposition;
  verified:boolean;
  settlement_commit?:string;
}

export interface HistoricalRun extends Run {
  obligation:Obligation;
  definition_commit:string;
}

export interface Lifecycle {
  status:LifecycleStatus;
  run?:Run;
}

export interface HistoryProjection {
  lifecycles:Map<string,Lifecycle>;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  receipts:Receipt[];
}

export interface FactCommit {
  commit:string;
  parent:string|null;
  obligation?:unknown|null;
  claim?:unknown|null;
  receipt?:unknown|null;
}

export interface Projection {
  state:State;
  history:HistoryProjection;
}

const IN_FLIGHT=new Set<WorkStatus>(['EXECUTING','WAITING','RECOVERY_REQUIRED']);
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

export function emptyState():State {
  return {obligations:{},definition_commits:{}};
}

export function validateDependencies(dependencies:Dependency[]):void {
  for (const edge of dependencies) {
    if (!edge || typeof edge.upstream!=='string' || edge.upstream.length===0) {
      throw new Error('INVALID_DEPENDENCY');
    }
    if (edge.kind==='control') continue;
    if (
      edge.kind!=='semantic'
      || !edge.consumes
      || !['output','evidence'].includes(edge.consumes.kind)
      || typeof edge.consumes.selector!=='string'
      || edge.consumes.selector.length===0
    ) {
      throw new Error('INVALID_DEPENDENCY');
    }
  }
}

export function normalizeObligation(input:ObligationInput):Obligation {
  if (!input || typeof input.id!=='string' || input.id.length===0) {
    throw new Error('INVALID_OBLIGATION_ID');
  }
  validatePostcondition(input.postcondition);
  const dependencies:Dependency[]=structuredClone(input.dependencies??[]);
  validateDependencies(dependencies);
  return {
    id:input.id,
    dependencies,
    packet:structuredClone(input.packet??{}),
    postcondition:structuredClone(input.postcondition),
  };
}

export function validateStoredObligation(obligation:Obligation):Obligation {
  if (!obligation || typeof obligation!=='object') throw new Error('INVALID_OBLIGATION');
  const raw=obligation as unknown as Record<string,unknown>;
  if ('deps' in raw) throw new Error('LEGACY_DEPENDENCY_PROJECTION_UNSUPPORTED');
  if (typeof obligation.id!=='string' || obligation.id.length===0) {
    throw new Error('INVALID_OBLIGATION_ID');
  }
  if (!Array.isArray(obligation.dependencies)) throw new Error('INVALID_DEPENDENCIES');
  if (!raw.packet || typeof raw.packet!=='object' || Array.isArray(raw.packet)) {
    throw new Error('INVALID_PACKET');
  }
  validateDependencies(obligation.dependencies);
  validatePostcondition(obligation.postcondition);
  return structuredClone(obligation);
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
    if (
      upstream.postcondition.verifier==='file-content-equals/v1'
      || upstream.postcondition.verifier==='eventually-consistent-file-content-equals/v1'
    ) {
      return `sha256:${sha256(upstream.postcondition.content)}`;
    }
    if (upstream.postcondition.verifier==='github-commit-status/v1') {
      return digest({
        provider:'github',
        repository_id:upstream.postcondition.repository_id,
        commit_sha:upstream.postcondition.commit_sha,
        context:githubStatusContextKey(upstream.postcondition.context),
        state:upstream.postcondition.expected_state,
      });
    }
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

function effectSemantics(
  postcondition:Postcondition,
):{resource:string;desired:string;sameDesiredCommutes:boolean}|null {
  if (postcondition.verifier!=='github-commit-status/v1') return null;
  return {
    resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desired:postcondition.expected_state,
    sameDesiredCommutes:true,
  };
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

export function projectReceipt(
  fact:ReceiptFact,
  work:Obligation,
  settlementCommit?:string,
):Receipt {
  let disposition:Disposition;
  let verified=false;

  if (fact.kind==='observation') {
    if (!fact.observed) throw new Error('OBSERVATION_RECEIPT_MISSING_EVIDENCE');
    verified=observationVerified(work.postcondition,fact.observed);
    disposition=verified
      ? 'DONE'
      : fact.observed.mutation_certainty==='absent'
        ? 'READY'
        : 'RECOVERY_REQUIRED';
  } else {
    if (fact.observed) throw new Error('NONOBSERVATION_RECEIPT_HAS_EVIDENCE');
    disposition=fact.kind==='judgment-required' ? 'WAITING' : 'RECOVERY_REQUIRED';
  }

  return {
    ...fact,
    disposition,
    verified,
    ...(settlementCommit?{settlement_commit:settlementCommit}:{}),
  };
}

export function replayProjection(commits:FactCommit[]):Projection {
  const state=emptyState();
  let lifecycles=new Map<string,Lifecycle>();
  const runs=new Map<string,HistoricalRun>();
  const receiptsByRun=new Map<string,Receipt>();
  const receipts:Receipt[]=[];

  for (const record of commits) {
    if (record.obligation!=null) {
      const fact=record.obligation as ObligationFact;
      if (fact.schema!==OBLIGATION_SCHEMA) throw new Error('INVALID_OBLIGATION_SCHEMA');
      const obligation=validateStoredObligation(fact.obligation);
      const id=obligation.id;

      if (fact.kind==='defined') {
        if (state.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
      } else if (fact.kind==='amended') {
        if (!state.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
        if (fact.previous_definition_commit!==state.definition_commits[id]) {
          throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
        }
        if (hasInFlight(lifecycles)) throw new Error('AMEND_WHILE_IN_FLIGHT');
      } else {
        throw new Error('INVALID_OBLIGATION_KIND');
      }

      state.obligations[id]=obligation;
      state.definition_commits[id]=record.commit;
      validateGraph(state);
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    }

    if (record.claim!=null) {
      const claim=record.claim as ClaimFact;
      if (claim.schema!==CLAIM_SCHEMA) throw new Error('INVALID_CLAIM_SCHEMA');
      const obligation=state.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent!==claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(claim.obligation_id);
      if (current?.status!=='READY') throw new Error('CLAIM_WHILE_NOT_READY');
      const unsatisfied=dependencyUpstreams(obligation)
        .filter(dependency=>lifecycles.get(dependency)?.status!=='DONE');
      if (unsatisfied.length>0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

      const expectedKey=obligationKey(state,obligation,lifecycles,receiptsByRun);
      if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      if (claim.obligation_key!==expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

      const run:HistoricalRun={
        id:claim.run_id,
        obligation_id:claim.obligation_id,
        claimed_revision:claim.claimed_revision,
        claim_commit:record.commit,
        obligation_key:claim.obligation_key,
        obligation:structuredClone(obligation),
        definition_commit:state.definition_commits[claim.obligation_id],
      };
      runs.set(run.id,run);
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    }

    if (record.receipt==null) continue;
    const fact=record.receipt as ReceiptFact;
    if (fact.schema!==RECEIPT_SCHEMA) throw new Error('INVALID_RECEIPT_SCHEMA');
    if (!['observation','judgment-required','execution-terminated'].includes(fact.kind)) {
      throw new Error('INVALID_RECEIPT_KIND');
    }
    const run=runs.get(fact.run_id);
    if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
    if (run.obligation_id!==fact.obligation_id) throw new Error('RECEIPT_OBLIGATION_MISMATCH');
    if (fact.claimed_revision!==run.claimed_revision) throw new Error('RECEIPT_REVISION_MISMATCH');
    if (fact.claim_commit!==run.claim_commit) throw new Error('RECEIPT_CLAIM_MISMATCH');

    lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    const current=lifecycles.get(run.obligation_id);
    if (current?.run?.id!==run.id) throw new Error('RECEIPT_FOR_NONCURRENT_RUN');
    if (fact.kind==='judgment-required' && current.status!=='EXECUTING') {
      throw new Error('JUDGMENT_REQUIRED_WHILE_NOT_EXECUTING');
    }
    if (fact.kind==='execution-terminated' && current.status!=='EXECUTING') {
      throw new Error('EXECUTION_TERMINATED_WHILE_NOT_EXECUTING');
    }
    if (
      fact.kind==='observation'
      && !['EXECUTING','WAITING','RECOVERY_REQUIRED'].includes(current.status)
    ) {
      throw new Error('OBSERVATION_WHILE_NOT_RESOLVABLE');
    }
    const previous=receiptsByRun.get(run.id);
    if (previous && ['DONE','READY'].includes(previous.disposition)) {
      throw new Error('RECEIPT_AFTER_TERMINAL_SETTLEMENT');
    }

    const receipt=projectReceipt(fact,run.obligation,record.commit);
    receiptsByRun.set(run.id,receipt);
    receipts.push(receipt);
    lifecycles=deriveLifecycles(state,runs,receiptsByRun);
  }

  lifecycles=deriveLifecycles(state,runs,receiptsByRun);
  return {
    state,
    history:{lifecycles,runs,receiptsByRun,receipts},
  };
}
