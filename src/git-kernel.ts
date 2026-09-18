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
  validateGraph,
  withObligation,
} from './graph.ts';
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
  reconstructProjection,
} from './projection.ts';
import type { Projection } from './projection.ts';

export type { Receipt } from './facts.ts';

const DEFAULT_AUTHORITY_REF='refs/overcenter/state';
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
      ref=DEFAULT_AUTHORITY_REF,
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
    const {state,history}=projection;
    if (hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);

    const next=withObligation(state,obligation,revision);
    validateGraph(next);
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
    const {state,history}=projection;
    if (hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (!state.obligations[id]) throw new Error(`unknown obligation: ${id}`);

    const previous=state.definition_commits[id];
    const next=withObligation(state,obligation,revision);
    validateGraph(next);
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
    const {state,history}=this.#reconstructProjection(revision);
    return Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work=>projectWork(state,work,revision,history.lifecycles));
  }

  nextReadyWork():Work|null {
    const revision=this.#requireAuthorityRevision();
    const {state,history}=this.#reconstructProjection(revision);
    const work=Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .find(candidate=>claimabilityError(state,candidate,history.lifecycles)===null);
    return work ? projectWork(state,work,revision,history.lifecycles) : null;
  }

  claim(id:string,expectedRevision:string):Run {
    const revision=this.#requireAuthorityRevision();
    if (revision!==expectedRevision) throw new Error('STALE_REVISION');
    const {state,history}=this.#reconstructProjection(revision);
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
      claimed_revision:revision,
      obligation_key:key,
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
    };
  }

  reconcile(runId:string):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {state,history}=this.#reconstructProjection(revision);
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
      if (this.#store.cas(commit,revision)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('RECONCILE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(runId:string,diagnostic:Data={}):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {state,history}=this.#reconstructProjection(revision);
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
      if (this.#store.cas(commit,revision)) return {...receipt,settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recordExecutionTerminated(runId:string,diagnostic:Data={}):Receipt {
    for (let attempt=0;attempt<16;attempt+=1) {
      const revision=this.#requireAuthorityRevision();
      const {state,history}=this.#reconstructProjection(revision);
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
      receipt:this.#store.readJson(commit,'receipt.json'),
    }));
    return reconstructProjection(commits);
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
    const work=kernel.nextReadyWork();
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

    const receipt=kernel.reconcile(run.id);
    if (receipt.disposition==='DONE' || receipt.disposition==='ABSENT') continue;
    return {
      state:'RECOVERY_REQUIRED',
      work:work.id,
      run:run.id,
      advances:i+1,
    };
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
