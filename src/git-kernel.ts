import { createHash, randomUUID } from 'node:crypto';
import type {
  Data,
  ExecutionPermit,
  Observation,
  Postcondition,
  Run,
  TaskSession,
  Work,
} from './model.ts';
import { GitFactStore } from './git-store.ts';
import {
  observePostcondition,
  type ObservationContext,
} from './observation.ts';
import {
  CLAIM_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  REALIZATION_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  normalizeObligation,
} from './facts.ts';
import type {
  AcceptedRealization,
  ClaimFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationFact,
  ObligationInput,
  RealizationFact,
  Receipt,
  ReceiptFact,
  ReceiptKind,
} from './facts.ts';
import { withObligation } from './graph.ts';
import { validateAdmission } from './admission.ts';
import {
  hasInFlight,
  obligationKey,
} from './lifecycle.ts';
import {
  claimabilityError,
  projectWork,
} from './eligibility.ts';
import {
  projectReceipt,
  replayProjection,
} from './projection.ts';
import type { Projection } from './projection.ts';
import { verifyWorkerResult } from './realization.ts';
import { deriveAuthorizedProviderEffect } from './provider-effect.ts';

export type { Receipt } from './facts.ts';

export interface EffectReservationIdentity {
  effect_contract:string;
  adapter_contract_digest:string;
  effect_digest:string;
  realization_commit:string|null;
  realization_digest:string|null;
}

const STATE_REF='refs/overcenter/state';

export class GitOvercenterKernel {
  readonly repo:string;
  readonly ref:string;
  readonly remote:string|null;
  readonly githubToken:string|null;
  readonly observationContext:ObservationContext;
  readonly #store:GitFactStore;

  constructor(
    repo:string,
    {
      ref=STATE_REF,
      remote=null,
      githubToken=null,
      observationContext={},
    }:{
      ref?:string;
      remote?:string|null;
      githubToken?:string|null;
      observationContext?:Omit<ObservationContext,'githubToken'>;
    }={},
  ) {
    this.repo=repo;
    this.ref=ref;
    this.remote=remote;
    this.githubToken=githubToken;
    this.observationContext={githubToken,...observationContext};
    this.#store=new GitFactStore(repo,{ref,remote});
  }

  initialize():string {
    const existing=this.head();
    if (existing) return existing;
    const commit=this.#store.createCommit(null,'overcenter: initialize');
    if (this.#store.cas(commit,this.#store.zeroObjectId())) return commit;
    const winner=this.head();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#projection(winner);
    return winner;
  }

  head():string|null {
    return this.#store.head();
  }

  define(input:ObligationInput):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const head=this.#requireHead();
    const projection=this.#projection(head);
    const {state,history}=projection;
    if (hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);

    const next=withObligation(state,obligation,head);
    validateAdmission(next);
    const fact:ObligationFact={schema:OBLIGATION_SCHEMA,kind:'defined',obligation};
    const commit=this.#store.createCommit(
      head,
      `overcenter: define ${id}`,
      {'obligation.json':fact},
    );
    if (!this.#store.cas(commit,head)) throw new Error('DEFINE_LOST');
    return commit;
  }

  amend(input:ObligationInput,expectedRevision:string):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const head=this.#requireHead();
    if (head!==expectedRevision) throw new Error('STALE_REVISION');
    const projection=this.#projection(head);
    const {state,history}=projection;
    if (hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
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
    const commit=this.#store.createCommit(
      head,
      `overcenter: amend ${id}`,
      {'obligation.json':fact},
    );
    if (!this.#store.cas(commit,head)) throw new Error('AMEND_LOST');
    return commit;
  }

  inspect():Work[] {
    const head=this.#requireHead();
    const {state,history}=this.#projection(head);
    return Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work=>projectWork(state,work,head,history.lifecycles));
  }

  deriveReadyWork():Work|null {
    const head=this.#requireHead();
    const {state,history}=this.#projection(head);
    const work=Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .find(candidate=>claimabilityError(state,candidate,history.lifecycles)===null);
    return work ? projectWork(state,work,head,history.lifecycles) : null;
  }

  claim(id:string,expectedRevision:string):ExecutionPermit {
    const head=this.#requireHead();
    if (head!==expectedRevision) throw new Error('STALE_REVISION');
    const {state,history}=this.#projection(head);
    const work=state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const claimError=claimabilityError(state,work,history.lifecycles);
    if (claimError) throw new Error(claimError);
    const key=obligationKey(state,work,history.lifecycles,history.receiptsByRun);
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
    const commit=this.#store.createCommit(
      head,
      `overcenter: claim ${id} ${runId}`,
      {'claim.json':claim},
    );
    if (!this.#store.cas(commit,head)) throw new Error('CLAIM_LOST');
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

  acceptRealization(
    session:TaskSession,
    candidate:unknown,
  ):AcceptedRealization {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {history}=this.#projection(head);
      const run=this.#requireTaskSession(history,session);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==run.id || lifecycle.status!=='EXECUTING') {
        throw new Error('REALIZATION_WHILE_NOT_EXECUTING');
      }
      if (history.unresolvedReservationsByRun.has(run.id)) {
        throw new Error('REALIZATION_AFTER_EFFECT_RESERVATION');
      }

      const existing=history.acceptedRealizationsByRun.get(run.id);
      if (existing) return existing;

      const verified=verifyWorkerResult(run.obligation,candidate);
      const fact:RealizationFact={
        schema:REALIZATION_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        claimed_revision:run.claimed_revision,
        execution_generation:run.execution_generation,
        execution_authority_commit:run.execution_authority_commit,
        verifier:verified.verifier,
        result_digest:verified.result_digest,
      };
      const commit=this.#store.createCommit(
        head,
        `overcenter: accept realization ${run.obligation_id} ${run.id} g${run.execution_generation}`,
        {'realization.json':fact},
      );
      if (this.#store.cas(commit,head)) {
        return {...fact,realization_commit:commit};
      }
    }
    throw new Error('REALIZATION_ACCEPTANCE_CONTENTION_EXHAUSTED');
  }

  acceptedRealization(session:TaskSession):AcceptedRealization|null {
    const head=this.#requireHead();
    const {history}=this.#projection(head);
    const run=this.#requireTaskSession(history,session);
    return history.acceptedRealizationsByRun.get(run.id)??null;
  }

  acquireExecution(
    runId:string,
    {
      expectedGeneration,
      expectedAuthorityCommit,
    }:{
      expectedGeneration?:number;
      expectedAuthorityCommit?:string;
    }={},
  ):ExecutionPermit {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {history}=this.#projection(head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      if (
        (expectedGeneration!==undefined
          && run.execution_generation!==expectedGeneration)
        || (expectedAuthorityCommit!==undefined
          && run.execution_authority_commit!==expectedAuthorityCommit)
      ) {
        throw new Error('STALE_EXECUTION_SESSION');
      }
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','READY'].includes(prior.disposition)) {
        throw new Error('RUN_ALREADY_TERMINAL');
      }
      const lifecycle=history.lifecycles.get(run.obligation_id);
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
      const commit=this.#store.createCommit(
        head,
        `overcenter: acquire execution ${run.obligation_id} ${run.id} g${fact.generation}`,
        {'execution-authority.json':fact},
      );
      if (!this.#store.cas(commit,head)) continue;
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

  beginEffect(
    permit:ExecutionPermit,
    identity:EffectReservationIdentity,
  ):string {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {history}=this.#projection(head);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==run.id || lifecycle.status!=='EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      if (history.unresolvedReservationsByRun.has(run.id)) {
        throw new Error('UNRESOLVED_EFFECT');
      }

      const expectedEffect=deriveAuthorizedProviderEffect(run.obligation);
      if (!expectedEffect) throw new Error('EFFECT_AUTHORITY_REQUIRED');
      if (
        identity.effect_contract!==expectedEffect.effect_contract
        || identity.adapter_contract_digest!==expectedEffect.adapter_contract_digest
        || identity.effect_digest!==expectedEffect.effect_digest
      ) {
        throw new Error('EFFECT_IDENTITY_MISMATCH');
      }

      const acceptance=run.obligation.result_acceptance;
      const realization=history.acceptedRealizationsByRun.get(run.id);
      if (acceptance) {
        if (!realization) throw new Error('REALIZATION_REQUIRED');
        if (
          identity.realization_commit!==realization.realization_commit
          || identity.realization_digest!==realization.result_digest
        ) {
          throw new Error('EFFECT_REALIZATION_MISMATCH');
        }
      } else if (
        identity.realization_commit!==null
        || identity.realization_digest!==null
      ) {
        throw new Error('UNEXPECTED_EFFECT_REALIZATION_BINDING');
      }

      const fact:EffectReservationFact={
        schema:EFFECT_RESERVATION_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        execution_generation:run.execution_generation,
        execution_authority_commit:run.execution_authority_commit,
        effect_contract:identity.effect_contract,
        adapter_contract_digest:identity.adapter_contract_digest,
        effect_digest:identity.effect_digest,
        realization_commit:identity.realization_commit,
        realization_digest:identity.realization_digest,
      };
      const commit=this.#store.createCommit(
        head,
        `overcenter: reserve effect ${run.obligation_id} ${run.id} g${run.execution_generation} ${identity.effect_digest}`,
        {'effect-reservation.json':fact},
      );
      if (this.#store.cas(commit,head)) return commit;
    }
    throw new Error('EFFECT_RESERVATION_CONTENTION_EXHAUSTED');
  }

  resolve(permit:ExecutionPermit):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','READY'].includes(prior.disposition)) return prior;
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId) {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      if (!['EXECUTING','RECOVERY_REQUIRED','WAITING'].includes(lifecycle.status)) {
        if (prior) return prior;
        throw new Error('NOT_RESOLVABLE');
      }

      const observed=this.#observe(work.postcondition);
      const fact=this.#receiptFact(run,work.id,'observation',observed);
      const receipt=projectReceipt(fact,work);
      const commit=this.#store.createCommit(
        head,
        `overcenter: observe ${work.id} ${run.id}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,head)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      if (history.unresolvedReservationsByRun.has(runId)) {
        throw new Error('UNRESOLVED_EFFECT');
      }

      const fact=this.#receiptFact(run,work.id,'judgment-required',null,diagnostic);
      const receipt=projectReceipt(fact,work);
      const commit=this.#store.createCommit(
        head,
        `overcenter: judgment required ${work.id} ${run.id}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,head)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recoverInterrupted(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=history.lifecycles.get(run.obligation_id);
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
      const commit=this.#store.createCommit(
        head,
        `overcenter: execution terminated ${work.id} ${runId}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,head)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('RECOVERY_CONTENTION_EXHAUSTED');
  }

  reconcile(permit:ExecutionPermit):Receipt {
    return this.resolve(permit);
  }

  receipts(runId:string|null=null):Receipt[] {
    const head=this.#requireHead();
    const {history}=this.#projection(head);
    return runId
      ? history.receipts.filter(receipt=>receipt.run_id===runId)
      : history.receipts;
  }

  #requireHead():string {
    const head=this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    return head;
  }

  #projection(head:string):Projection {
    const commits:FactCommit[]=this.#store.revisions(head).map(commit=>({
      commit,
      parent:this.#store.parent(commit),
      obligation:this.#store.readJson(commit,'obligation.json'),
      claim:this.#store.readJson(commit,'claim.json'),
      execution_authority:this.#store.readJson(commit,'execution-authority.json'),
      realization:this.#store.readJson(commit,'realization.json'),
      effect_reservation:this.#store.readJson(commit,'effect-reservation.json'),
      receipt:this.#store.readJson(commit,'receipt.json'),
    }));
    return replayProjection(commits);
  }

  #observe(postcondition:Postcondition):Observation {
    return observePostcondition(postcondition,this.observationContext);
  }

  #capabilityDigest(capability:string):string {
    return createHash('sha256').update(capability).digest('hex');
  }

  #requireTaskSession(
    history:Projection['history'],
    session:TaskSession,
  ):HistoricalRun {
    if (session.schema!=='overcenter-task-session-v2') {
      throw new Error('INVALID_TASK_SESSION_SCHEMA');
    }
    const run=history.runs.get(session.run_id);
    if (!run) throw new Error('UNKNOWN_RUN');
    if (
      run.obligation_id!==session.obligation_id
      || run.claimed_revision!==session.claimed_revision
    ) {
      throw new Error('TASK_SESSION_IDENTITY_MISMATCH');
    }
    if (
      run.execution_generation!==session.execution_generation
      || run.execution_authority_commit!==session.execution_authority_commit
    ) {
      throw new Error('TASK_SESSION_STALE');
    }
    return run;
  }

  #requireExecutionPermit(
    history:Projection['history'],
    permit:ExecutionPermit,
  ):HistoricalRun {
    const run=history.runs.get(permit.id);
    if (!run) throw new Error('UNKNOWN_RUN');
    if (
      permit.execution_generation!==run.execution_generation
      || permit.execution_authority_commit!==run.execution_authority_commit
      || permit.execution_capability_sha256!==run.execution_capability_sha256
      || this.#capabilityDigest(permit.execution_capability)!==run.execution_capability_sha256
    ) {
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

