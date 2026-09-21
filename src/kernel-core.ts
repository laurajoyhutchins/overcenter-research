import { createHash, randomUUID } from 'node:crypto';
import type {
  Data,
  ExecuteOutcome,
  ExecutionPermit,
  LoopOptions,
  LoopResult,
  Observation,
  Postcondition,
  Run,
  Work,
} from './model.ts';
import type { DurableFactStore } from './fact-store.ts';
import {
  observePostcondition, observePostconditionAsync,
  type ObservationContext,
} from './observation.ts';
import {
  CLAIM_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  normalizeObligation,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  HistoricalRun,
  ObligationFact,
  ObligationInput,
  Receipt,
  ReceiptFact,
  ReceiptKind,
} from './facts.ts';
import { withObligation } from './graph.ts';
import { validateAdmission } from './admission.ts';
import {
  deriveProjectProjection,
  explainProjectWork,
  hasInFlight,
  type ProjectExplanation,
} from './projector.ts';
import { deriveCurrentRealizationJudgments } from './realization-admissibility.ts';
import {
  projectReceipt,
  replayProjection,
} from './projection.ts';
import type { Projection } from './projection.ts';
import { mutationAdmitted, projectExecutionAuthority } from './transaction-admission.ts';

export type { Receipt } from './facts.ts';

const errorMessage=(error:unknown)=>error instanceof Error ? error.message : String(error);

export interface KernelOptions {
  githubToken?:string|null;
  observationContext?:Omit<ObservationContext,'githubToken'>;
}

export class KernelCore {
  readonly githubToken:string|null;
  readonly observationContext:ObservationContext;
  readonly #store:DurableFactStore;

  constructor(
    store:DurableFactStore,
    {
      githubToken=null,
      observationContext={},
    }:KernelOptions={},
  ) {
    this.#store=store;
    this.githubToken=githubToken;
    this.observationContext={githubToken,...observationContext};
  }

  initialize():string {
    const existing=this.head();
    if (existing) return existing;
    const commit=this.#store.append(null,'overcenter: initialize');
    if (commit) return commit;
    const winner=this.head();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#historicalProjection(winner);
    return winner;
  }

  head():string|null {
    return this.#store.head();
  }

  define(input:ObligationInput):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const head=this.#requireHead();
    const projection=this.#historicalProjection(head);
    const {state,project}=projection;
    if (hasInFlight(project)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);

    const next=withObligation(state,obligation,head);
    validateAdmission(next);
    const fact:ObligationFact={schema:OBLIGATION_SCHEMA,kind:'defined',obligation};
    const commit=this.#store.append(
      head,
      `overcenter: define ${id}`,
      {'obligation.json':fact},
    );
    if (!commit) throw new Error('DEFINE_LOST');
    return commit;
  }

  amend(input:ObligationInput,expectedRevision:string):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const head=this.#requireHead();
    if (head!==expectedRevision) throw new Error('STALE_REVISION');
    const projection=this.#historicalProjection(head);
    const {state,project}=projection;
    if (hasInFlight(project)) throw new Error('PROJECT_BUSY');
    if (!state.obligations[id]) throw new Error(`unknown obligation: ${id}`);

    const previous=state.definition_commits[id];
    const next=withObligation(state,obligation,head);
    validateAdmission(next);
    const fact:ObligationFact={
      schema:OBLIGATION_SCHEMA,
      kind:'amended',
      obligation,
      previous_definition_commit:previous,
    };
    const commit=this.#store.append(
      head,
      `overcenter: amend ${id}`,
      {'obligation.json':fact},
    );
    if (!commit) throw new Error('AMEND_LOST');
    return commit;
  }

  inspect():Work[] {
    const head=this.#requireHead();
    return this.#currentProjection(head).project.work;
  }

  claimedWork(runId:string):Work {
    const head=this.#requireHead();
    const current=this.#historicalProjection(head);
    const run=current.history.runs.get(runId);
    if (!run) throw new Error('UNKNOWN_RUN');
    const atClaim=this.#historicalProjection(run.claim_commit);
    const work=atClaim.project.work.find(candidate=>candidate.id===run.obligation_id);
    if (
      !work
      || work.status!=='EXECUTING'
      || work.run_id!==runId
      || work.claimed_revision!==run.claimed_revision
      || work.revision!==run.claim_commit
    ) {
      throw new Error('CLAIMED_WORK_RECONSTRUCTION_FAILED');
    }
    return structuredClone(work);
  }

  deriveReadyWork():Work|null {
    const head=this.#requireHead();
    return this.#currentProjection(head).project.readyWork;
  }

  explain(id:string):ProjectExplanation {
    const head=this.#requireHead();
    return explainProjectWork(this.#currentProjection(head).project,id);
  }

  claim(id:string,expectedRevision:string):ExecutionPermit {
    const head=this.#requireHead();
    if (head!==expectedRevision) throw new Error('STALE_REVISION');
    const {state,project}=this.#currentProjection(head);
    const work=state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const claimError=project.claimabilityErrors.get(id);
    if (claimError) throw new Error(claimError);
    const key=project.semanticKeys.get(id);
    if (!key) throw new Error('SEMANTIC_DEPENDENCY_UNRESOLVED');

    const runId=randomUUID();
    const executionCapability=randomUUID();
    const executionCapabilitySha256=this.#capabilityDigest(executionCapability);
    const claim:ClaimFact={
      schema:CLAIM_SCHEMA,
      run_id:runId,
      obligation_id:id,
      claimed_revision:head,
      obligation_key:key,
      execution_capability_sha256:executionCapabilitySha256,
    };
    const commit=this.#store.append(
      head,
      `overcenter: claim ${id} ${runId}`,
      {'claim.json':claim},
    );
    if (!commit) throw new Error('CLAIM_LOST');
    return {
      id:runId,
      obligation_id:id,
      claimed_revision:head,
      claim_commit:commit,
      obligation_key:key,
      execution_generation:1,
      execution_authority_commit:commit,
      execution_capability_sha256:executionCapabilitySha256,
      execution_capability:executionCapability,
    };
  }

  acquireExecution(runId:string):ExecutionPermit {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {history,project}=this.#historicalProjection(head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','READY'].includes(prior.disposition)) {
        throw new Error('RUN_ALREADY_TERMINAL');
      }
      const lifecycle=project.lifecycles.get(run.obligation_id);
      if (
        lifecycle?.run?.id!==runId
        || !['EXECUTING','RECOVERY_REQUIRED','WAITING'].includes(lifecycle.status)
      ) {
        throw new Error('AUTHORITY_LOST');
      }

      const executionCapability=randomUUID();
      const executionCapabilitySha256=this.#capabilityDigest(executionCapability);
      const fact:ExecutionAuthorityFact={
        schema:EXECUTION_AUTHORITY_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        generation:run.execution_generation+1,
        previous_authority_commit:run.execution_authority_commit,
        execution_capability_sha256:executionCapabilitySha256,
      };
      const commit=this.#store.append(
        head,
        `overcenter: acquire execution ${run.obligation_id} ${run.id} g${fact.generation}`,
        {'execution-authority.json':fact},
      );
      if (!commit) continue;
      return {
        ...run,
        execution_generation:fact.generation,
        execution_authority_commit:commit,
        execution_capability_sha256:executionCapabilitySha256,
        execution_capability:executionCapability,
      };
    }
    throw new Error('EXECUTION_AUTHORITY_CONTENTION_EXHAUSTED');
  }

  beginEffect(permit:ExecutionPermit):string {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {history,project}=this.#historicalProjection(head);
      const run=history.runs.get(permit.id);
      if (!run) throw new Error('UNKNOWN_RUN');
      const authority=projectExecutionAuthority(
        run,
        permit,
        this.#capabilityDigest(permit.execution_capability),
      );
      if (!authority.current_authority || !authority.exact_revision) {
        throw new Error('STALE_EXECUTION_GENERATION');
      }
      const lifecycle=project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==run.id || lifecycle.status!=='EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      if (!mutationAdmitted({
        ...authority,
        unresolved_effect:history.unresolvedReservationsByRun.has(run.id),
      })) throw new Error('UNRESOLVED_EFFECT');

      const fact:EffectReservationFact={
        schema:EFFECT_RESERVATION_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        execution_generation:run.execution_generation,
        execution_authority_commit:run.execution_authority_commit,
      };
      const commit=this.#store.append(
        head,
        `overcenter: reserve effect ${run.obligation_id} ${run.id} g${run.execution_generation}`,
        {'effect-reservation.json':fact},
      );
      if (commit) return commit;
    }
    throw new Error('EFFECT_RESERVATION_CONTENTION_EXHAUSTED');
  }

  async performEffect<T>(
    permit:ExecutionPermit,
    effect:()=>Promise<T>|T,
  ):Promise<T> {
    this.beginEffect(permit);
    return await effect();
  }

  resolve(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const candidate=this.#resolutionCandidate(permit);
      if ('receipt' in candidate) return candidate.receipt;
      const settled=this.#commitObservation(
        candidate,
        this.#observe(candidate.work.postcondition),
        diagnostic,
      );
      if (settled) return settled;
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  async resolveAsync(
    permit:ExecutionPermit,
    diagnostic:Data={},
  ):Promise<Receipt> {
    for (let attempt=0;attempt<16;attempt+=1) {
      const candidate=this.#resolutionCandidate(permit);
      if ('receipt' in candidate) return candidate.receipt;
      const settled=this.#commitObservation(
        candidate,
        await this.#observeAsync(candidate.work.postcondition),
        diagnostic,
      );
      if (settled) return settled;
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history,project}=this.#historicalProjection(head);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      if (history.unresolvedReservationsByRun.has(runId)) {
        throw new Error('UNRESOLVED_EFFECT');
      }

      const fact=this.#receiptFact(run,work.id,'judgment-required',null,diagnostic);
      const receipt=projectReceipt(fact,work);
      const commit=this.#store.append(
        head,
        `overcenter: judgment required ${work.id} ${run.id}`,
        {'receipt.json':fact},
      );
      if (commit) return {...receipt,settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recoverInterrupted(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history,project}=this.#historicalProjection(head);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('RUN_NOT_EXECUTING');
      }

      const fact=this.#receiptFact(
        run,
        work.id,
        'execution-terminated',
        null,
        diagnostic,
      );
      const receipt=projectReceipt(fact,work);
      const commit=this.#store.append(
        head,
        `overcenter: execution terminated ${work.id} ${runId}`,
        {'receipt.json':fact},
      );
      if (commit) return {...receipt,settlement_commit:commit};
    }
    throw new Error('RECOVERY_CONTENTION_EXHAUSTED');
  }

  reconcile(permit:ExecutionPermit):Receipt {
    return this.resolve(permit);
  }

  receipts(runId:string|null=null):Receipt[] {
    const head=this.#requireHead();
    const {history,project}=this.#historicalProjection(head);
    return runId
      ? history.receipts.filter(receipt=>receipt.run_id===runId)
      : history.receipts;
  }

  hasUnresolvedEffect(runId:string):boolean {
    const head=this.#requireHead();
    return this.#historicalProjection(head).history.unresolvedReservationsByRun.has(runId);
  }

  #resolutionCandidate(
    permit:ExecutionPermit,
  ):
    | {receipt:Receipt}
    | {head:string;run:HistoricalRun;work:HistoricalRun['obligation']} {
    const runId=permit.id;
    const head=this.#requireHead();
    const {state,history,project}=this.#historicalProjection(head);
    const known=history.runs.get(runId);
    if (!known) throw new Error('UNKNOWN_RUN');
    if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
    const work=known.obligation;
    const prior=history.receiptsByRun.get(runId);
    if (prior && ['DONE','READY'].includes(prior.disposition)) {
      return {receipt:prior};
    }
    const run=this.#requireExecutionPermit(history,permit);
    const lifecycle=project.lifecycles.get(run.obligation_id);
    if (lifecycle?.run?.id!==runId) {
      if (prior) return {receipt:prior};
      throw new Error('AUTHORITY_LOST');
    }
    if (!['EXECUTING','RECOVERY_REQUIRED','WAITING'].includes(lifecycle.status)) {
      if (prior) return {receipt:prior};
      throw new Error('NOT_RESOLVABLE');
    }
    return {head,run,work};
  }

  #commitObservation(
    candidate:{head:string;run:HistoricalRun;work:HistoricalRun['obligation']},
    observed:Observation,
    diagnostic:Data,
  ):Receipt|null {
    const {head,run,work}=candidate;
    const fact=this.#receiptFact(
      run,
      work.id,
      'observation',
      observed,
      diagnostic,
    );
    const receipt=projectReceipt(fact,work);
    const commit=this.#store.append(
      head,
      `overcenter: observe ${work.id} ${run.id}`,
      {'receipt.json':fact},
    );
    return commit ? {...receipt,settlement_commit:commit} : null;
  }

  #requireHead():string {
    const head=this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    return head;
  }

  #historicalProjection(head:string):Projection {
    return replayProjection(this.#store.history(head));
  }

  #currentProjection(head:string):Projection {
    const historical=this.#historicalProjection(head);
    const currentRealizationJudgments=deriveCurrentRealizationJudgments({
      state:historical.state,
      runs:historical.history.runs,
      receiptsByRun:historical.history.receiptsByRun,
      semanticKeys:historical.project.semanticKeys,
      observe:postcondition=>this.#observe(postcondition),
    });
    const project=deriveProjectProjection({
      state:historical.state,
      runs:historical.history.runs,
      receiptsByRun:historical.history.receiptsByRun,
      revision:head,
      currentRealizationJudgments,
    });
    return {
      ...historical,
      project,
    };
  }

  #observe(postcondition:Postcondition):Observation {
    return observePostcondition(postcondition,this.observationContext);
  }

  async #observeAsync(postcondition:Postcondition):Promise<Observation> {
    return await observePostconditionAsync(postcondition,this.observationContext);
  }

  #capabilityDigest(capability:string):string {
    return createHash('sha256').update(capability).digest('hex');
  }

  #requireExecutionPermit(
    history:Projection['history'],
    permit:ExecutionPermit,
  ):HistoricalRun {
    const run=history.runs.get(permit.id);
    if (!run) throw new Error('UNKNOWN_RUN');
    const authority=projectExecutionAuthority(
      run,
      permit,
      this.#capabilityDigest(permit.execution_capability),
    );
    if (!authority.current_authority || !authority.exact_revision) {
      throw new Error('STALE_EXECUTION_GENERATION');
    }
    return run;
  }

  #receiptFact(
    run:Run,
    obligationId:string,
    kind:ReceiptKind,
    observed:Observation|null,
    diagnostic?:Data,
  ):ReceiptFact {
    return {
      schema:RECEIPT_SCHEMA,
      run_id:run.id,
      obligation_id:obligationId,
      claimed_revision:run.claimed_revision,
      claim_commit:run.claim_commit,
      execution_generation:run.execution_generation,
      execution_authority_commit:run.execution_authority_commit,
      kind,
      observed,
      ...(diagnostic?{diagnostic}:{}),
      settled_at:new Date().toISOString(),
    };
  }
}

export async function runCoreLoop(
  kernel:KernelCore,
  {preflight,effect,maxAdvances=100}:LoopOptions,
):Promise<LoopResult> {
  kernel.inspect();
  for (let i=0;i<maxAdvances;i+=1) {
    const work=kernel.deriveReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) return {state:'BLOCKED',work:blocked.id,advances:i};
      return {state:'IDLE',advances:i};
    }

    let run:ExecutionPermit;
    try {
      run=kernel.claim(work.id,work.revision);
    } catch (error:unknown) {
      const message=errorMessage(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }

    if (preflight) {
      const decision=await preflight(work.packet);
      if (decision.kind==='judgment-required') {
        kernel.deferForJudgment(run,{decision});
        return {
          state:'WAITING',
          work:work.id,
          run:run.id,
          advances:i+1,
        };
      }
      if (decision.kind!=='execute') throw new Error('INVALID_PREFLIGHT_OUTCOME');
    }

    // Crossing into the effectful executor is only legal after the kernel has
    // validated the current execution permit and durably reserved the effect.
    // A failed reservation therefore fails before provider code is invoked.
    kernel.beginEffect(run);

    let outcome:ExecuteOutcome;
    try {
      outcome=await effect(work.packet);
    } catch (error:unknown) {
      outcome={
        kind:'execution-error',
        error:errorMessage(error),
        may_have_mutated:true,
      };
    }

    // Once the effect boundary has been crossed, an effect handler can no longer
    // downgrade the attempt to a non-effectful WAITING state. Its outcome must
    // be reconciled as a potentially mutating interrupted execution.
    if (outcome.kind==='judgment-required') {
      kernel.recoverInterrupted(run,{
        outcome,
        protocol_error:'JUDGMENT_AFTER_EFFECT_RESERVATION',
      });
      return {
        state:'RECOVERY_REQUIRED',
        work:work.id,
        run:run.id,
        advances:i+1,
      };
    }

    const receipt=await kernel.resolveAsync(run);
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') continue;
    return {
      state:'RECOVERY_REQUIRED',
      work:work.id,
      run:run.id,
      advances:i+1,
    };
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
