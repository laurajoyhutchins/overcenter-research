import { randomUUID } from 'node:crypto';
import type {
  Data,
  ExecuteOutcome,
  LoopOptions,
  LoopResult,
  Observation,
  Postcondition,
  Run,
  Work,
} from './model.ts';
import { GitFactStore } from './git-store.ts';
import { observePostcondition } from './observation.ts';
import {
  CLAIM_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  normalizeObligation,
} from './facts.ts';
import type {
  ClaimFact,
  FactCommit,
  ObligationFact,
  ObligationInput,
  Receipt,
  ReceiptFact,
  ReceiptKind,
} from './facts.ts';
import {
  claimabilityError,
  hasInFlight,
  obligationKey,
  projectWork,
  validateGraph,
  withObligation,
} from './graph.ts';
import {
  projectReceipt,
  replayProjection,
} from './projection.ts';
import type { Projection } from './projection.ts';

export type { Receipt } from './facts.ts';

const STATE_REF='refs/overcenter/state';
const errorMessage=(error:unknown)=>error instanceof Error ? error.message : String(error);

export class GitOvercenterKernel {
  readonly repo:string;
  readonly ref:string;
  readonly remote:string|null;
  readonly githubToken:string|null;
  readonly #store:GitFactStore;

  constructor(
    repo:string,
    {
      ref=STATE_REF,
      remote=null,
      githubToken=null,
    }:{ref?:string;remote?:string|null;githubToken?:string|null}={},
  ) {
    this.repo=repo;
    this.ref=ref;
    this.remote=remote;
    this.githubToken=githubToken;
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
    validateGraph(next);
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
    validateGraph(next);
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

  claim(id:string,expectedRevision:string):Run {
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
    const claim:ClaimFact={
      schema:CLAIM_SCHEMA,
      run_id:runId,
      obligation_id:id,
      claimed_revision:head,
      obligation_key:key,
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
    };
  }

  resolve(runId:string):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[run.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','READY'].includes(prior.disposition)) return prior;
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

  deferForJudgment(runId:string,diagnostic:Data={}):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[run.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
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

  recoverInterrupted(runId:string,diagnostic:Data={}):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const head=this.#requireHead();
      const {state,history}=this.#projection(head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      if (!state.obligations[run.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
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

  reconcile(runId:string):Receipt {
    return this.resolve(runId);
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
      receipt:this.#store.readJson(commit,'receipt.json'),
    }));
    return replayProjection(commits);
  }

  #observe(postcondition:Postcondition):Observation {
    return observePostcondition(postcondition,{githubToken:this.githubToken});
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
      kind,
      observed,
      ...(diagnostic?{diagnostic}:{}),
      settled_at:new Date().toISOString(),
    };
  }
}

export async function runGitCoreLoop(
  kernel:GitOvercenterKernel,
  {execute,maxAdvances=100}:LoopOptions,
):Promise<LoopResult> {
  kernel.inspect();
  for (let i=0;i<maxAdvances;i+=1) {
    const work=kernel.deriveReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) return {state:'BLOCKED',work:blocked.id,advances:i};
      return {state:'IDLE',advances:i};
    }

    let run:Run;
    try {
      run=kernel.claim(work.id,work.revision);
    } catch (error:unknown) {
      const message=errorMessage(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }

    let outcome:ExecuteOutcome;
    try {
      outcome=await execute(work.packet,run);
    } catch (error:unknown) {
      outcome={
        kind:'execution-error',
        error:errorMessage(error),
        may_have_mutated:true,
      };
    }
    if (outcome.kind==='judgment-required') {
      kernel.deferForJudgment(run.id,{outcome});
      return {
        state:'WAITING',
        work:work.id,
        run:run.id,
        advances:i+1,
      };
    }

    const receipt=kernel.resolve(run.id);
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
