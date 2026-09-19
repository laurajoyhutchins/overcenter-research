import { randomUUID } from 'node:crypto';
import { sha256 } from './digest.ts';
import type {
  Data,
  ExecutionPermit,
  Observation,
  Postcondition,
  Run,
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
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  normalizeObligation,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  RunRecord,
  ObligationFact,
  ObligationInput,
  Receipt,
  ReceiptFact,
  ReceiptKind,
} from './facts.ts';
import { withObligation } from './graph.ts';
import { validateAdmission } from './admission.ts';
import {
  hasUnsettledRun,
  obligationKey,
} from './lifecycle.ts';
import {
  claimBlockReason,
  projectWork,
} from './eligibility.ts';
import {
  projectReceipt,
  reconstructProjection,
} from './projection.ts';
import type { Projection } from './projection.ts';

export type { Receipt } from './facts.ts';

const DEFAULT_AUTHORITY_REF='refs/overcenter/state';

export class GitOvercenterKernel {
  readonly #observationContext:ObservationContext;
  readonly #store:GitFactStore;

  constructor(
    repo:string,
    {
      ref=DEFAULT_AUTHORITY_REF,
      remote=null,
      observationContext={},
    }:{
      ref?:string;
      remote?:string|null;
      observationContext?:ObservationContext;
    }={},
  ) {
    this.#observationContext=observationContext;
    this.#store=new GitFactStore(repo,{ref,remote});
  }

  initialize():string {
    const existing=this.authorityRevision();
    if (existing) return existing;
    const commit=this.#store.createCommit(null,'overcenter: initialize');
    if (this.#store.cas(commit,this.#store.zeroObjectId())) return commit;
    const winner=this.authorityRevision();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#reconstructProjection(winner);
    return winner;
  }

  authorityRevision():string|null {
    return this.#store.refRevision();
  }

  define(input:ObligationInput):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const revision=this.#requireAuthorityRevision();
    const projection=this.#reconstructProjection(revision);
    const {catalog,history}=projection;
    if (hasUnsettledRun(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (catalog.obligations[id]) throw new Error(`duplicate obligation: ${id}`);

    const nextCatalog=withObligation(catalog,obligation,revision);
    validateAdmission(nextCatalog);
    const fact:ObligationFact={schema:OBLIGATION_SCHEMA,kind:'defined',obligation};
    const commit=this.#store.createCommit(
      revision,
      `overcenter: define ${id}`,
      {'obligation.json':fact},
    );
    if (!this.#store.cas(commit,revision)) throw new Error('DEFINE_LOST');
    return commit;
  }

  amend(input:ObligationInput,expectedRevision:string):string {
    const obligation=normalizeObligation(input);
    const {id}=obligation;
    const revision=this.#requireAuthorityRevision();
    if (revision!==expectedRevision) throw new Error('STALE_REVISION');
    const projection=this.#reconstructProjection(revision);
    const {catalog,history}=projection;
    if (hasUnsettledRun(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (!catalog.obligations[id]) throw new Error(`unknown obligation: ${id}`);

    const previous=catalog.definition_commits[id];
    const nextCatalog=withObligation(catalog,obligation,revision);
    validateAdmission(nextCatalog);
    const fact:ObligationFact={
      schema:OBLIGATION_SCHEMA,
      kind:'amended',
      obligation,
      previous_definition_commit:previous,
    };
    const commit=this.#store.createCommit(
      revision,
      `overcenter: amend ${id}`,
      {'obligation.json':fact},
    );
    if (!this.#store.cas(commit,revision)) throw new Error('AMEND_LOST');
    return commit;
  }

  inspect():Work[] {
    const revision=this.#requireAuthorityRevision();
    const {catalog,history}=this.#reconstructProjection(revision);
    return Object.values(catalog.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work=>projectWork(catalog,work,revision,history.lifecycles));
  }

  nextReadyWork():Work|null {
    const revision=this.#requireAuthorityRevision();
    const {catalog,history}=this.#reconstructProjection(revision);
    const work=Object.values(catalog.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .find(candidate=>claimBlockReason(catalog,candidate,history.lifecycles)===null);
    return work ? projectWork(catalog,work,revision,history.lifecycles) : null;
  }

  claim(id:string,expectedRevision:string):ExecutionPermit {
    const revision=this.#requireAuthorityRevision();
    if (revision!==expectedRevision) throw new Error('STALE_REVISION');
    const {catalog,history}=this.#reconstructProjection(revision);
    const work=catalog.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const claimError=claimBlockReason(catalog,work,history.lifecycles);
    if (claimError) throw new Error(claimError);
    const key=obligationKey(catalog,work,history.lifecycles,history.receiptsByRun);
    if (!key) throw new Error('SEMANTIC_DEPENDENCY_UNRESOLVED');

    const runId=randomUUID();
    const executionCapability=randomUUID();
    const executionCapabilitySha256=sha256(executionCapability);
    const claim:ClaimFact={
      schema:CLAIM_SCHEMA,
      run_id:runId,
      obligation_id:id,
      claimed_revision:revision,
      obligation_key:key,
      execution_capability_sha256:executionCapabilitySha256,
    };
    const commit=this.#store.createCommit(
      revision,
      `overcenter: claim ${id} ${runId}`,
      {'claim.json':claim},
    );
    if (!this.#store.cas(commit,revision)) throw new Error('CLAIM_LOST');
    return {
      id:runId,
      obligation_id:id,
      claimed_revision:revision,
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
      const revision=this.#requireAuthorityRevision();
      const {history}=this.#reconstructProjection(revision);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','ABSENT'].includes(prior.disposition)) {
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
      const executionCapabilitySha256=sha256(executionCapability);
      const fact:ExecutionAuthorityFact={
        schema:EXECUTION_AUTHORITY_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        generation:run.execution_generation+1,
        previous_authority_commit:run.execution_authority_commit,
        execution_capability_sha256:executionCapabilitySha256,
      };
      const commit=this.#store.createCommit(
        revision,
        `overcenter: acquire execution ${run.obligation_id} ${run.id} g${fact.generation}`,
        {'execution-authority.json':fact},
      );
      if (!this.#store.cas(commit,revision)) continue;
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
      const revision=this.#requireAuthorityRevision();
      const {history}=this.#reconstructProjection(revision);
      const run=this.#requireExecutionPermit(history,permit);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==run.id || lifecycle.status!=='EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      if (history.unresolvedReservationsByRun.has(run.id)) {
        throw new Error('UNRESOLVED_EFFECT');
      }

      const fact:EffectReservationFact={
        schema:EFFECT_RESERVATION_SCHEMA,
        run_id:run.id,
        obligation_id:run.obligation_id,
        execution_generation:run.execution_generation,
        execution_authority_commit:run.execution_authority_commit,
      };
      const commit=this.#store.createCommit(
        revision,
        `overcenter: reserve effect ${run.obligation_id} ${run.id} g${run.execution_generation}`,
        {'effect-reservation.json':fact},
      );
      if (this.#store.cas(commit,revision)) return commit;
    }
    throw new Error('EFFECT_RESERVATION_CONTENTION_EXHAUSTED');
  }


  reconcile(permit:ExecutionPermit):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {history}=this.#reconstructProjection(revision);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      const work=known.obligation;
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','ABSENT'].includes(prior.disposition)) return prior;
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
        revision,
        `overcenter: observe ${work.id} ${run.id}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,revision)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('RECONCILE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {history}=this.#reconstructProjection(revision);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
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
        revision,
        `overcenter: judgment required ${work.id} ${run.id}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,revision)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recordExecutionTerminated(permit:ExecutionPermit,diagnostic:Data={}):Receipt {
    const runId=permit.id;
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {history}=this.#reconstructProjection(revision);
      const known=history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
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
        revision,
        `overcenter: execution terminated ${work.id} ${runId}`,
        {'receipt.json':fact},
      );
      if (this.#store.cas(commit,revision)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('TERMINATION_RECORD_CONTENTION_EXHAUSTED');
  }


  receipts(runId:string|null=null):Receipt[] {
    const revision=this.#requireAuthorityRevision();
    const {history}=this.#reconstructProjection(revision);
    return runId
      ? history.receipts.filter(receipt=>receipt.run_id===runId)
      : history.receipts;
  }

  #requireAuthorityRevision():string {
    const revision=this.authorityRevision();
    if (!revision) throw new Error('NOT_INITIALIZED');
    return revision;
  }

  #reconstructProjection(revision:string):Projection {
    const commits:FactCommit[]=this.#store.revisions(revision).map(commit=>({
      commit,
      parent:this.#store.parent(commit),
      obligation:this.#store.readJson(commit,'obligation.json'),
      claim:this.#store.readJson(commit,'claim.json'),
      execution_authority:this.#store.readJson(commit,'execution-authority.json'),
      effect_reservation:this.#store.readJson(commit,'effect-reservation.json'),
      receipt:this.#store.readJson(commit,'receipt.json'),
    }));
    return reconstructProjection(commits);
  }

  #observe(postcondition:Postcondition):Observation {
    return observePostcondition(postcondition,this.#observationContext);
  }


  #requireExecutionPermit(
    history:Projection['history'],
    permit:ExecutionPermit,
  ):RunRecord {
    const run=history.runs.get(permit.id);
    if (!run) throw new Error('UNKNOWN_RUN');
    if (
      permit.execution_generation!==run.execution_generation
      || permit.execution_authority_commit!==run.execution_authority_commit
      || permit.execution_capability_sha256!==run.execution_capability_sha256
      || sha256(permit.execution_capability)!==run.execution_capability_sha256
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

