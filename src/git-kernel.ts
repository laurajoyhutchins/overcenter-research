import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const STATE_REF = 'refs/overcenter/state';
const OBLIGATION_SCHEMA = 'overcenter-git-obligation-v2';
const CLAIM_SCHEMA = 'overcenter-git-claim-v2';
const RECEIPT_SCHEMA = 'overcenter-git-receipt-v3';

type LifecycleStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type WorkStatus = LifecycleStatus | 'BLOCKED';
export type Disposition = 'DONE' | 'READY' | 'WAITING' | 'RECOVERY_REQUIRED';
export type MutationCertainty = 'present' | 'absent' | 'uncertain';
export type Data = Record<string, unknown>;

export interface FileContentPostcondition {
  verifier: 'file-content-equals/v1';
  path: string;
  content: string;
}
export interface GitRefPostcondition {
  verifier: 'git-ref-equals/v1';
  remote: string;
  ref: string;
  target_sha: string;
}
export interface GitHubCommitStatusPostcondition {
  verifier: 'github-commit-status/v1';
  provider: 'github';
  repository_id: number;
  commit_sha: string;
  context: string;
  expected_state: 'error' | 'failure' | 'pending' | 'success';
}
export type Postcondition = FileContentPostcondition | GitRefPostcondition | GitHubCommitStatusPostcondition;

export interface Observation extends Data {
  verifier: Postcondition['verifier'];
  mutation_certainty: MutationCertainty;
  path?: string;
  expected_sha256?: string;
  actual_sha256?: string;
  remote?: string;
  ref?: string;
  expected_sha?: string;
  actual_sha?: string;
  provider?: 'github';
  repository_id?: number;
  repository_full_name?: string;
  commit_sha?: string;
  context?: string;
  expected_state?: string;
  actual_state?: string;
}

export type Dependency =
  | { kind: 'control'; upstream: string }
  | {
      kind: 'semantic';
      upstream: string;
      consumes:
        | { kind: 'output'; selector: string }
        | { kind: 'evidence'; selector: string };
    };

export interface Obligation {
  id: string;
  deps: string[];
  dependencies: Dependency[];
  packet: Data;
  postcondition: Postcondition;
}

interface ObligationInput {
  id: string;
  deps?: string[];
  dependencies?: Dependency[];
  packet?: Data;
  postcondition: Postcondition;
}
interface State {
  obligations: Record<string, Obligation>;
  definition_commits: Record<string, string>;
}
type ObligationFact =
  | {
      schema: typeof OBLIGATION_SCHEMA;
      kind: 'defined';
      obligation: Obligation;
    }
  | {
      schema: typeof OBLIGATION_SCHEMA;
      kind: 'amended';
      obligation: Obligation;
      previous_definition_commit: string;
    }
export interface Work extends Obligation {
  status: WorkStatus;
  revision: string;
  run_id?: string;
  claimed_revision?: string;
  blocked_reason?: string;
}
export interface Run {
  id: string;
  obligation_id: string;
  claimed_revision: string;
  claim_commit: string;
  obligation_key: string;
}
interface ClaimFact {
  schema: typeof CLAIM_SCHEMA;
  run_id: string;
  obligation_id: string;
  claimed_revision: string;
  obligation_key: string;
}
interface Lifecycle {
  status: LifecycleStatus;
  run?: Run;
}
type ReceiptKind = 'observation' | 'judgment-required' | 'execution-terminated';
interface ReceiptFact {
  schema: typeof RECEIPT_SCHEMA;
  run_id: string;
  obligation_id: string;
  claimed_revision: string;
  claim_commit: string;
  kind: ReceiptKind;
  observed: Observation | null;
  diagnostic?: Data;
  settled_at: string;
}
interface HistoricalRun extends Run {
  obligation: Obligation;
  definition_commit: string;
}
interface HistoryProjection {
  lifecycles: Map<string,Lifecycle>;
  runs: Map<string,HistoricalRun>;
  receiptsByRun: Map<string,Receipt>;
  receipts: Receipt[];
}
export interface Receipt extends ReceiptFact {
  disposition: Disposition;
  verified: boolean;
  settlement_commit?: string;
}
export interface ExecuteOutcome extends Data { kind?: string; may_have_mutated?: boolean }
export interface LoopOptions { execute: (packet: Data, run: Run) => Promise<ExecuteOutcome>; maxAdvances?: number }
export interface LoopResult { state: 'IDLE'|'BLOCKED'|'RECOVERY_REQUIRED'|'WAITING'|'BUDGET_EXHAUSTED'; advances: number; work?: string; run?: string }
interface GitResult { ok: boolean; stdout: string; stderr?: string }

const IN_FLIGHT = new Set<WorkStatus>(['EXECUTING','WAITING','RECOVERY_REQUIRED']);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);

export class GitOvercenterKernel {
  readonly repo: string;
  readonly ref: string;
  readonly remote: string | null;
  readonly githubToken: string | null;

  constructor(
    repo: string,
    {
      ref = STATE_REF,
      remote = null,
      githubToken = null,
    }: { ref?: string; remote?: string | null; githubToken?: string | null } = {},
  ) {
    this.repo = repo;
    this.ref = ref;
    this.remote = remote;
    this.githubToken = githubToken;
    this.#git(['rev-parse','--git-dir']);
  }

  initialize(): string {
    const existing = this.head();
    if (existing) return existing;
    const commit = this.#commit(null, 'overcenter: initialize');
    const zero = '0'.repeat(this.#objectIdLength());
    if (this.#cas(commit, zero)) return commit;
    const winner = this.head();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#state(winner);
    return winner;
  }

  head(): string | null {
    if (!this.remote) {
      const result = this.#git(['rev-parse','-q','--verify',this.ref], { allowFailure: true });
      return result.ok ? result.stdout.trim() : null;
    }
    const listed = this.#git(['ls-remote', this.remote, this.ref], { allowFailure: true });
    if (!listed.ok) throw new Error('AUTHORITY_UNREACHABLE');
    const line = listed.stdout.trim();
    if (!line) {
      this.#git(['update-ref','-d',this.ref], { allowFailure: true });
      return null;
    }
    const sha = line.split(/\s+/)[0];
    const fetched = this.#git(['fetch','--no-tags',this.remote,`+${this.ref}:${this.ref}`], { allowFailure: true });
    if (!fetched.ok) throw new Error('AUTHORITY_UNREACHABLE');
    return sha;
  }

  define(input: ObligationInput): string {
    const obligation=this.#normalizeObligation(input);
    const {id,postcondition}=obligation;
    this.#validatePostcondition(postcondition);
    const head = this.#requireHead();
    const state = this.#state(head);
    const history=this.#history(state,head);
    if (this.#hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);

    const next=this.#withObligation(state,obligation,'defined',head);
    this.#validateGraph(next);
    const fact:ObligationFact={schema:OBLIGATION_SCHEMA,kind:'defined',obligation};
    const commit = this.#commit(head, `overcenter: define ${id}`, null, null, fact);
    if (!this.#cas(commit, head)) throw new Error('DEFINE_LOST');
    return commit;
  }

  amend(input: ObligationInput, expectedRevision: string): string {
    const obligation=this.#normalizeObligation(input);
    const {id,postcondition}=obligation;
    this.#validatePostcondition(postcondition);
    const head=this.#requireHead();
    if (head!==expectedRevision) throw new Error('STALE_REVISION');
    const state=this.#state(head);
    const history=this.#history(state,head);
    if (this.#hasInFlight(history.lifecycles)) throw new Error('PROJECT_BUSY');
    if (!state.obligations[id]) throw new Error(`unknown obligation: ${id}`);

    const previous=state.definition_commits[id];
    const next=this.#withObligation(state,obligation,'amended',head);
    this.#validateGraph(next);
    const fact:ObligationFact={
      schema:OBLIGATION_SCHEMA,
      kind:'amended',
      obligation,
      previous_definition_commit:previous,
    };
    const commit=this.#commit(head,`overcenter: amend ${id}`,null,null,fact);
    if (!this.#cas(commit,head)) throw new Error('AMEND_LOST');
    return commit;
  }

  inspect(): Work[] {
    const head = this.#requireHead();
    const state = this.#state(head);
    const history=this.#history(state,head);
    return Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work => this.#projectWork(state, work, head, history.lifecycles));
  }

  deriveReadyWork(): Work | null {
    const head = this.#requireHead();
    const state = this.#state(head);
    const history=this.#history(state,head);
    const work = Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .find(candidate => this.#claimabilityError(state, candidate, history.lifecycles)===null);
    return work ? this.#projectWork(state, work, head, history.lifecycles) : null;
  }

  claim(id: string, expectedRevision: string): Run {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');
    const state = this.#state(head);
    const work = state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const history=this.#history(state,head);
    const claimabilityError=this.#claimabilityError(state,work,history.lifecycles);
    if (claimabilityError) throw new Error(claimabilityError);
    const obligationKey=this.#obligationKey(state,work,history.lifecycles,history.receiptsByRun);
    if (!obligationKey) throw new Error('SEMANTIC_DEPENDENCY_UNRESOLVED');
    const runId = randomUUID();
    const claim:ClaimFact={
      schema:CLAIM_SCHEMA,
      run_id:runId,
      obligation_id:id,
      claimed_revision:head,
      obligation_key:obligationKey,
    };
    const commit = this.#commit(head,`overcenter: claim ${id} ${runId}`,null,claim);
    if (!this.#cas(commit,head)) throw new Error('CLAIM_LOST');
    return {
      id:runId,
      obligation_id:id,
      claimed_revision:head,
      claim_commit:commit,
      obligation_key:obligationKey,
    };
  }

  resolve(runId: string): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head = this.#requireHead();
      const state = this.#state(head);
      const history=this.#history(state,head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const currentWork=state.obligations[run.obligation_id];
      if (!currentWork) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
      if (prior && ['DONE','READY'].includes(prior.disposition)) return prior;
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId) {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      const status=lifecycle.status;
      if (!['EXECUTING','RECOVERY_REQUIRED','WAITING'].includes(status)) {
        if (prior) return prior;
        throw new Error('NOT_RESOLVABLE');
      }

      const observed = this.#observe(work.postcondition);
      const fact = this.#receiptFact(run,work,'observation',observed);
      const receipt = this.#projectReceipt(fact,work);
      const commit=this.#commit(head,`overcenter: observe ${work.id} ${run.id}`,fact);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(runId: string, diagnostic: Data = {}): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head=this.#requireHead();
      const state=this.#state(head);
      const history=this.#history(state,head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const currentWork=state.obligations[run.obligation_id];
      if (!currentWork) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      const fact=this.#receiptFact(run,work,'judgment-required',null,diagnostic);
      const receipt=this.#projectReceipt(fact,work);
      const commit=this.#commit(head,`overcenter: judgment required ${work.id} ${run.id}`,fact);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recoverInterrupted(runId: string, diagnostic: Data = {}): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head=this.#requireHead();
      const state=this.#state(head);
      const history=this.#history(state,head);
      const run=history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const currentWork=state.obligations[run.obligation_id];
      if (!currentWork) throw new Error('UNKNOWN_OBLIGATION');
      const work=run.obligation;
      const prior=history.receiptsByRun.get(runId);
      const lifecycle=history.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id!==runId || lifecycle.status!=='EXECUTING') {
        if (prior) return prior;
        throw new Error('RUN_NOT_EXECUTING');
      }
      const fact=this.#receiptFact(
        run,
        work,
        'execution-terminated',
        null,
        diagnostic,
      );
      const receipt=this.#projectReceipt(fact,work);
      const commit=this.#commit(head,`overcenter: execution terminated ${work.id} ${runId}`,fact);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('RECOVERY_CONTENTION_EXHAUSTED');
  }

  reconcile(runId: string): Receipt { return this.resolve(runId); }

  receipts(runId: string | null = null): Receipt[] {
    const head=this.#requireHead();
    const history=this.#history(this.#state(head),head);
    return runId ? history.receipts.filter(receipt=>receipt.run_id===runId) : history.receipts;
  }

  #history(state:State,head:string): HistoryProjection {
    const replay=this.#emptyState();
    let lifecycles=new Map<string,Lifecycle>();
    const runs=new Map<string,HistoricalRun>();
    const receiptsByRun=new Map<string,Receipt>();
    const receipts:Receipt[]=[];
    const revs=this.#git(['rev-list','--reverse',head]).stdout.trim().split(/\n+/).filter(Boolean);

    for (const commit of revs) {
      const obligationFile=this.#git(['show',`${commit}:obligation.json`],{allowFailure:true});
      if (obligationFile.ok) {
        const fact=JSON.parse(obligationFile.stdout) as ObligationFact;
        if (fact.schema!==OBLIGATION_SCHEMA) throw new Error('INVALID_OBLIGATION_SCHEMA');
        const obligation=this.#normalizeStoredObligation(fact.obligation);
        const id=obligation.id;

        if (fact.kind==='defined') {
          if (replay.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
        } else if (fact.kind==='amended') {
          if (!replay.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
          if (fact.previous_definition_commit!==replay.definition_commits[id]) {
            throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
          }
          if (this.#hasInFlight(lifecycles)) throw new Error('AMEND_WHILE_IN_FLIGHT');
        } else {
          throw new Error('INVALID_OBLIGATION_KIND');
        }

        replay.obligations[id]=obligation;
        replay.definition_commits[id]=commit;
        this.#validateGraph(replay);
        lifecycles=this.#deriveLifecycles(replay,runs,receiptsByRun);
      }

      const claimFile=this.#git(['show',`${commit}:claim.json`],{allowFailure:true});
      if (claimFile.ok) {
        const claim=JSON.parse(claimFile.stdout) as ClaimFact;
        if (claim.schema!==CLAIM_SCHEMA) throw new Error('INVALID_CLAIM_SCHEMA');
        const obligation=replay.obligations[claim.obligation_id];
        if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
        if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
        const parent=this.#git(['rev-parse',`${commit}^`]).stdout.trim();
        if (parent!==claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

        lifecycles=this.#deriveLifecycles(replay,runs,receiptsByRun);
        const current=lifecycles.get(claim.obligation_id);
        if (current?.status!=='READY') throw new Error('CLAIM_WHILE_NOT_READY');
        const unsatisfied=obligation.deps.filter(dep=>lifecycles.get(dep)?.status!=='DONE');
        if (unsatisfied.length>0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

        const expectedKey=this.#obligationKey(replay,obligation,lifecycles,receiptsByRun);
        if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
        if (claim.obligation_key!==expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

        const run:HistoricalRun={
          id:claim.run_id,
          obligation_id:claim.obligation_id,
          claimed_revision:claim.claimed_revision,
          claim_commit:commit,
          obligation_key:claim.obligation_key,
          obligation:structuredClone(obligation),
          definition_commit:replay.definition_commits[claim.obligation_id],
        };
        runs.set(run.id,run);
        lifecycles=this.#deriveLifecycles(replay,runs,receiptsByRun);
      }

      const receiptFile=this.#git(['show',`${commit}:receipt.json`],{allowFailure:true});
      if (!receiptFile.ok) continue;
      const fact=JSON.parse(receiptFile.stdout) as ReceiptFact;
      if (fact.schema!==RECEIPT_SCHEMA) throw new Error('INVALID_RECEIPT_SCHEMA');
      if (!['observation','judgment-required','execution-terminated'].includes(fact.kind)) {
        throw new Error('INVALID_RECEIPT_KIND');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) throw new Error('RECEIPT_OBLIGATION_MISMATCH');
      if (fact.claimed_revision!==run.claimed_revision) throw new Error('RECEIPT_REVISION_MISMATCH');
      if (fact.claim_commit!==run.claim_commit) throw new Error('RECEIPT_CLAIM_MISMATCH');

      lifecycles=this.#deriveLifecycles(replay,runs,receiptsByRun);
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

      const receipt=this.#projectReceipt(fact,run.obligation,commit);
      receiptsByRun.set(run.id,receipt);
      receipts.push(receipt);
      lifecycles=this.#deriveLifecycles(replay,runs,receiptsByRun);
    }

    if (JSON.stringify(replay.obligations)!==JSON.stringify(state.obligations)) {
      throw new Error('GRAPH_REPLAY_MISMATCH');
    }
    lifecycles=this.#deriveLifecycles(state,runs,receiptsByRun);
    return {lifecycles,runs,receiptsByRun,receipts};
  }

  #requireHead(): string { const head=this.head(); if (!head) throw new Error('NOT_INITIALIZED'); return head; }
  #emptyState(): State { return {obligations:{},definition_commits:{}}; }

  #normalizeObligation(input:ObligationInput): Obligation {
    if (!input || typeof input.id!=='string' || input.id.length===0) {
      throw new Error('INVALID_OBLIGATION_ID');
    }
    this.#validatePostcondition(input.postcondition);
    const dependencies:Dependency[]=input.dependencies
      ? structuredClone(input.dependencies)
      : (input.deps ?? []).map(upstream=>({kind:'control' as const,upstream}));

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

    const deps=[...new Set(dependencies.map(edge=>edge.upstream))];
    if (input.deps) {
      const declared=[...new Set(input.deps)].sort();
      const typed=[...deps].sort();
      if (JSON.stringify(declared)!==JSON.stringify(typed)) {
        throw new Error('DEPENDENCY_DECLARATION_MISMATCH');
      }
    }

    return {
      id:input.id,
      deps,
      dependencies,
      packet:structuredClone(input.packet ?? {}),
      postcondition:structuredClone(input.postcondition),
    };
  }

  #normalizeStoredObligation(obligation:Obligation): Obligation {
    return this.#normalizeObligation({
      id:obligation.id,
      deps:obligation.deps,
      dependencies:obligation.dependencies,
      packet:obligation.packet,
      postcondition:obligation.postcondition,
    });
  }

  #deriveLifecycles(
    state:State,
    runs:Map<string,HistoricalRun>,
    receiptsByRun:Map<string,Receipt>,
  ): Map<string,Lifecycle> {
    const lifecycles=new Map<string,Lifecycle>();
    const visiting=new Set<string>();
    const allRuns=[...runs.values()];

    const derive=(id:string):Lifecycle => {
      const existing=lifecycles.get(id);
      if (existing) return existing;
      if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
      visiting.add(id);

      const work=state.obligations[id];
      if (!work) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
      for (const edge of work.dependencies) {
        if (edge.kind==='semantic') derive(edge.upstream);
      }

      const key=this.#obligationKey(state,work,lifecycles,receiptsByRun);
      let lifecycle:Lifecycle={status:'READY'};

      if (key) {
        const candidates=allRuns.filter(run=>
          run.obligation_id===id && run.obligation_key===key
        );
        const done=[...candidates].reverse().find(run=>
          receiptsByRun.get(run.id)?.disposition==='DONE'
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

  #obligationKey(
    state:State,
    work:Obligation,
    lifecycles:Map<string,Lifecycle>,
    receiptsByRun:Map<string,Receipt>,
  ): string|null {
    const semantic=work.dependencies
      .filter((edge):edge is Extract<Dependency,{kind:'semantic'}>=>edge.kind==='semantic');

    const consumed:Array<{
      consumes:Extract<Dependency,{kind:'semantic'}>['consumes'];
      identity:string;
    }>=[];
    for (const edge of semantic) {
      const identity=this.#semanticDependencyIdentity(state,edge,lifecycles,receiptsByRun);
      if (!identity) return null;
      consumed.push({
        consumes:structuredClone(edge.consumes),
        identity,
      });
    }
    consumed.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

    return this.#digest({
      id:work.id,
      packet:work.packet,
      postcondition:work.postcondition,
      semantic_dependencies:consumed,
    });
  }

  #semanticDependencyIdentity(
    state:State,
    edge:Extract<Dependency,{kind:'semantic'}>,
    lifecycles:Map<string,Lifecycle>,
    receiptsByRun:Map<string,Receipt>,
  ): string|null {
    const upstream=state.obligations[edge.upstream];
    if (!upstream) throw new Error(`UNKNOWN_DEPENDENCY:${edge.upstream}`);
    const lifecycle=lifecycles.get(edge.upstream);
    if (lifecycle?.status!=='DONE' || !lifecycle.run) return null;

    if (edge.consumes.kind==='output' && edge.consumes.selector==='verified-content') {
      if (upstream.postcondition.verifier==='file-content-equals/v1') {
        return `sha256:${sha256(upstream.postcondition.content)}`;
      }
      if (upstream.postcondition.verifier==='git-ref-equals/v1') {
        return `git-object:${upstream.postcondition.target_sha}`;
      }
      if (upstream.postcondition.verifier==='github-commit-status/v1') {
        return this.#digest({
          provider:'github',
          repository_id:upstream.postcondition.repository_id,
          commit_sha:upstream.postcondition.commit_sha,
          context:this.#githubStatusContextKey(upstream.postcondition.context),
          state:upstream.postcondition.expected_state,
        });
      }
    }

    if (edge.consumes.kind==='evidence' && edge.consumes.selector==='settlement-receipt') {
      const receipt=receiptsByRun.get(lifecycle.run.id);
      if (receipt?.disposition!=='DONE' || !receipt.settlement_commit) return null;
      return `settlement:${receipt.settlement_commit}`;
    }

    throw new Error(`UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`);
  }

  #digest(value:unknown): string {
    const canonical=(input:unknown):unknown => {
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
  #hasInFlight(lifecycles: Map<string,Lifecycle>): boolean {
    return [...lifecycles.values()].some(({status})=>IN_FLIGHT.has(status));
  }
  #effectSemantics(
    postcondition: Postcondition,
  ): { resource: string; desired: string; sameDesiredCommutes: boolean } | null {
    if (postcondition.verifier!=='github-commit-status/v1') return null;
    return {
      resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${this.#githubStatusContextKey(postcondition.context)}`,
      desired:postcondition.expected_state,
      sameDesiredCommutes:true,
    };
  }
  #dependsOn(state: State, fromId: string, targetId: string, seen = new Set<string>()): boolean {
    if (fromId===targetId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const work=state.obligations[fromId];
    if (!work) return false;
    return work.deps.some(dep=>dep===targetId || this.#dependsOn(state,dep,targetId,seen));
  }
  #claimabilityError(
    state: State,
    work: Obligation,
    lifecycles: Map<string,Lifecycle>,
  ): string | null {
    if (lifecycles.get(work.id)?.status!=='READY') return 'NOT_READY';
    const done=new Set(
      Object.values(state.obligations)
        .filter(candidate=>lifecycles.get(candidate.id)?.status==='DONE')
        .map(candidate=>candidate.id),
    );
    if (!work.deps.every(dep=>done.has(dep))) return 'DEPENDENCIES_NOT_DONE';

    const semantics=this.#effectSemantics(work.postcondition);
    if (!semantics) return null;

    for (const other of Object.values(state.obligations)) {
      if (other.id===work.id) continue;
      const otherSemantics=this.#effectSemantics(other.postcondition);
      if (!otherSemantics || otherSemantics.resource!==semantics.resource) continue;

      const sameDesired=otherSemantics.desired===semantics.desired;
      if (sameDesired && semantics.sameDesiredCommutes && otherSemantics.sameDesiredCommutes) continue;

      const ordered=this.#dependsOn(state,work.id,other.id)
        || this.#dependsOn(state,other.id,work.id);
      if (!ordered) return `UNORDERED_EFFECT_CONFLICT:${work.id}:${other.id}`;
    }
    return null;
  }
  #projectWork(
    state: State,
    work: Obligation,
    revision: string,
    lifecycles: Map<string,Lifecycle>,
  ): Work {
    const lifecycle=lifecycles.get(work.id) ?? {status:'READY' as LifecycleStatus};
    const projected={
      ...structuredClone(work),
      status:lifecycle.status,
      revision,
      ...(lifecycle.run?{run_id:lifecycle.run.id,claimed_revision:lifecycle.run.claimed_revision}:{}),
    } as Work;
    if (projected.status!=='READY') return projected;
    const reason=this.#claimabilityError(state,work,lifecycles);
    if (reason && reason!=='NOT_READY') {
      projected.status='BLOCKED';
      projected.blocked_reason=reason;
    }
    return projected;
  }
  #state(commit: string): State {
    const state=this.#emptyState();
    const revs=this.#git(['rev-list','--reverse',commit]).stdout.trim().split(/\n+/).filter(Boolean);
    for (const revision of revs) {
      const file=this.#git(['show',`${revision}:obligation.json`],{allowFailure:true});
      if (!file.ok) continue;
      const fact=JSON.parse(file.stdout) as ObligationFact;
      if (fact.schema!==OBLIGATION_SCHEMA) throw new Error('INVALID_OBLIGATION_SCHEMA');
      const obligation=this.#normalizeStoredObligation(fact.obligation);
      const id=obligation.id;
      if (fact.kind==='defined') {
        if (state.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
      } else if (fact.kind==='amended') {
        if (!state.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
        if (fact.previous_definition_commit!==state.definition_commits[id]) {
          throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
        }
      } else {
        throw new Error('INVALID_OBLIGATION_KIND');
      }
      state.obligations[id]=obligation;
      state.definition_commits[id]=revision;
      this.#validateGraph(state);
    }
    return state;
  }

  #withObligation(
    state:State,
    obligation:Obligation,
    _kind:'defined'|'amended',
    definitionCommit:string,
  ): State {
    return {
      obligations:{...structuredClone(state.obligations),[obligation.id]:structuredClone(obligation)},
      definition_commits:{...state.definition_commits,[obligation.id]:definitionCommit},
    };
  }

  #validateGraph(state:State): void {
    for (const obligation of Object.values(state.obligations)) {
      for (const dep of obligation.deps) {
        if (!state.obligations[dep]) throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${dep}`);
      }
    }

    const visiting=new Set<string>();
    const visited=new Set<string>();
    const visit=(id:string) => {
      if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of state.obligations[id].deps) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of Object.keys(state.obligations)) visit(id);
  }
  #validatePostcondition(p: Postcondition): void {
    if (p?.verifier==='file-content-equals/v1'
      && typeof p.path==='string'
      && typeof p.content==='string') return;
    if (p?.verifier==='git-ref-equals/v1'
      && typeof p.remote==='string'
      && typeof p.ref==='string'
      && typeof p.target_sha==='string') return;
    if (p?.verifier==='github-commit-status/v1'
      && p.provider==='github'
      && Number.isSafeInteger(p.repository_id)
      && p.repository_id > 0
      && /^[0-9a-f]{40,64}$/i.test(p.commit_sha)
      && typeof p.context==='string'
      && p.context.length > 0
      && ['error','failure','pending','success'].includes(p.expected_state)) return;
    throw new Error('UNSUPPORTED_POSTCONDITION');
  }
  #observe(p: Postcondition): Observation {
    this.#validatePostcondition(p);
    if (p.verifier==='github-commit-status/v1') {
      if (!this.githubToken) {
        return {
          verifier:p.verifier,
          provider:'github',
          repository_id:p.repository_id,
          commit_sha:p.commit_sha,
          context:p.context,
          expected_state:p.expected_state,
          mutation_certainty:'uncertain',
          observation_error:'GITHUB_TOKEN_UNAVAILABLE',
        };
      }
      try {
        const repository=this.#githubGet(`/repositories/${p.repository_id}`) as { id?: number; full_name?: string };
        if (repository.id!==p.repository_id || typeof repository.full_name!=='string') {
          throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
        }
        const status=this.#githubFindCommitStatus(
          repository.full_name,
          p.commit_sha,
          p.context,
        );
        if (!status) {
          return {
            verifier:p.verifier,
            provider:'github',
            repository_id:p.repository_id,
            repository_full_name:repository.full_name,
            commit_sha:p.commit_sha,
            context:p.context,
            expected_state:p.expected_state,
            mutation_certainty:'absent',
            };
        }
        return {
          verifier:p.verifier,
          provider:'github',
          repository_id:p.repository_id,
          repository_full_name:repository.full_name,
          commit_sha:p.commit_sha,
          context:p.context,
          expected_state:p.expected_state,
          actual_state:status.state,
          mutation_certainty:'present',
        };
      } catch (e: unknown) {
        return {
          verifier:p.verifier,
          provider:'github',
          repository_id:p.repository_id,
          commit_sha:p.commit_sha,
          context:p.context,
          expected_state:p.expected_state,
          mutation_certainty:'uncertain',
          observation_error:errorMessage(e),
        };
      }
    }

    if (p.verifier==='git-ref-equals/v1') {
      const listed=this.#git(['ls-remote',p.remote,p.ref],{allowFailure:true});
      if (!listed.ok) {
        return {
          verifier:p.verifier,
          remote:p.remote,
          ref:p.ref,
          expected_sha:p.target_sha,
          mutation_certainty:'uncertain',
          observation_error:listed.stderr ?? 'git ls-remote failed',
        };
      }
      const line=listed.stdout.trim();
      if (!line) {
        return {
          verifier:p.verifier,
          remote:p.remote,
          ref:p.ref,
          expected_sha:p.target_sha,
          mutation_certainty:'absent',
        };
      }
      const actualSha=line.split(/\s+/)[0];
      return {
        verifier:p.verifier,
        remote:p.remote,
        ref:p.ref,
        expected_sha:p.target_sha,
        actual_sha:actualSha,
        mutation_certainty:'present',
      };
    }

    const expected=sha256(p.content);
    try {
      const actual=readFileSync(p.path,'utf8');
      const actualSha=sha256(actual);
      return {verifier:p.verifier,path:p.path,expected_sha256:expected,actual_sha256:actualSha,mutation_certainty:'present'};
    } catch (e: unknown) {
      const code=(e as {code?:string}).code;
      if (code==='ENOENT') return {verifier:p.verifier,path:p.path,expected_sha256:expected,mutation_certainty:'absent'};
      return {verifier:p.verifier,path:p.path,expected_sha256:expected,mutation_certainty:'uncertain',observation_error:errorMessage(e)};
    }
  }
  #observationVerified(postcondition:Postcondition,observed:Observation): boolean {
    if (observed.verifier!==postcondition.verifier) throw new Error('OBSERVATION_VERIFIER_MISMATCH');
    if (observed.mutation_certainty!=='present') return false;

    if (postcondition.verifier==='file-content-equals/v1') {
      if (observed.path!==postcondition.path) throw new Error('OBSERVATION_COORDINATE_MISMATCH');
      return observed.actual_sha256===sha256(postcondition.content);
    }
    if (postcondition.verifier==='git-ref-equals/v1') {
      if (observed.remote!==postcondition.remote || observed.ref!==postcondition.ref) {
        throw new Error('OBSERVATION_COORDINATE_MISMATCH');
      }
      return observed.actual_sha===postcondition.target_sha;
    }
    if (
      observed.provider!=='github'
      || observed.repository_id!==postcondition.repository_id
      || observed.commit_sha!==postcondition.commit_sha
      || observed.context!==postcondition.context
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return observed.actual_state===postcondition.expected_state;
  }

  #projectReceipt(fact:ReceiptFact,work:Obligation,settlementCommit?:string): Receipt {
    let disposition:Disposition;
    let verified=false;

    if (fact.kind==='observation') {
      if (!fact.observed) throw new Error('OBSERVATION_RECEIPT_MISSING_EVIDENCE');
      verified=this.#observationVerified(work.postcondition,fact.observed);
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

  #receiptFact(
    run:Run,
    work:Obligation,
    kind:ReceiptKind,
    observed:Observation|null,
    diagnostic?:Data,
  ): ReceiptFact {
    return {
      schema:RECEIPT_SCHEMA,
      run_id:run.id,
      obligation_id:work.id,
      claimed_revision:run.claimed_revision,
      claim_commit:run.claim_commit,
      kind,
      observed,
      ...(diagnostic?{diagnostic}:{}),
      settled_at:new Date().toISOString(),
    };
  }
  #commit(
    parent:string|null,
    message:string,
    receipt:ReceiptFact|null=null,
    claim:ClaimFact|null=null,
    obligation:ObligationFact|null=null,
  ): string {
    const entries:Array<[string,string]>=[];
    if (obligation) entries.push(['obligation.json',this.#blob(json(obligation))]);
    if (claim) entries.push(['claim.json',this.#blob(json(claim))]);
    if (receipt) entries.push(['receipt.json',this.#blob(json(receipt))]);
    const treeInput=entries.sort(([a],[b])=>a.localeCompare(b)).map(([name,sha])=>`100644 blob ${sha}\t${name}\n`).join('');
    const tree=this.#git(['mktree'],{input:treeInput}).stdout.trim();
    const args=['commit-tree',tree]; if (parent) args.push('-p',parent);
    const env={...process.env,GIT_AUTHOR_NAME:'Overcenter Kernel',GIT_AUTHOR_EMAIL:'overcenter@local',GIT_COMMITTER_NAME:'Overcenter Kernel',GIT_COMMITTER_EMAIL:'overcenter@local'};
    return this.#git(args,{input:`${message}\n`,env}).stdout.trim();
  }
  #blob(content:string): string { return this.#git(['hash-object','-w','--stdin'],{input:content}).stdout.trim(); }
  #cas(next:string,expected:string): boolean {
    if (!this.remote) return this.#git(['update-ref',this.ref,next,expected],{allowFailure:true}).ok;
    const zero='0'.repeat(this.#objectIdLength());
    const lease=expected===zero ? `--force-with-lease=${this.ref}:` : `--force-with-lease=${this.ref}:${expected}`;
    const pushed=this.#git(['push','--porcelain',lease,this.remote,`${next}:${this.ref}`],{allowFailure:true});
    if (!pushed.ok) return false;
    this.#git(['update-ref',this.ref,next]);
    return true;
  }
  #objectIdLength(): number { return this.#git(['rev-parse','--show-object-format']).stdout.trim()==='sha256'?64:40; }
  #githubStatusContextKey(context: string): string { return context.toLowerCase(); }
  #githubFindCommitStatus(
    repositoryFullName: string,
    commitSha: string,
    context: string,
  ): { context?: string; state?: string } | null {
    const target=this.#githubStatusContextKey(context);
    for (let page=1; page<=1000; page+=1) {
      const statuses=this.#githubGet(
        `/repos/${repositoryFullName}/commits/${commitSha}/statuses?per_page=100&page=${page}`,
      );
      if (!Array.isArray(statuses)) throw new Error('GITHUB_STATUS_RESPONSE_INVALID');
      const typed=statuses as Array<{ context?: string; state?: string }>;
      const match=typed.find(candidate=>
        typeof candidate.context==='string'
        && this.#githubStatusContextKey(candidate.context)===target
      );
      if (match) return match;
      if (typed.length<100) return null;
    }
    throw new Error('GITHUB_STATUS_PAGINATION_EXHAUSTED');
  }
  #githubGet(path: string): unknown {
    if (!this.githubToken) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    const config = [
      `header = "Authorization: Bearer ${this.githubToken}"`,
      'header = "Accept: application/vnd.github+json"',
      'header = "X-GitHub-Api-Version: 2022-11-28"',
      '',
    ].join('\n');
    try {
      const stdout=execFileSync(
        'curl',
        ['--silent','--show-error','--fail-with-body','--config','-',`https://api.github.com${path}`],
        {input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']},
      );
      return JSON.parse(stdout);
    } catch (e: unknown) {
      const f=e as {stderr?:string|Buffer;stdout?:string|Buffer;message?:string};
      throw new Error(`GITHUB_PROVIDER_READ_FAILED: ${String(f.stderr??f.stdout??f.message??'').trim()}`);
    }
  }
  #git(args:string[],{input=undefined,env=process.env,allowFailure=false}:{input?:string;env?:Record<string,string|undefined>;allowFailure?:boolean}={}): GitResult {
    try {
      const stdout=execFileSync('git',['-C',this.repo,...args],{input,env,encoding:'utf8',stdio:['pipe','pipe','pipe']});
      return {ok:true,stdout};
    } catch (e: unknown) {
      const f=e as {stdout?:string|Buffer;stderr?:string|Buffer;message?:string};
      if (allowFailure) return {ok:false,stdout:String(f.stdout??''),stderr:String(f.stderr??'')};
      throw new Error(`git ${args.join(' ')} failed: ${String(f.stderr??f.message??'').trim()}`);
    }
  }
}

export async function runGitCoreLoop(kernel: GitOvercenterKernel,{execute,maxAdvances=100}:LoopOptions): Promise<LoopResult> {
  kernel.inspect();
  for (let i=0;i<maxAdvances;i+=1) {
    const work=kernel.deriveReadyWork();
    if (!work) {
      const blocked=kernel.inspect().find(candidate=>candidate.status==='BLOCKED');
      if (blocked) return {state:'BLOCKED',work:blocked.id,advances:i};
      return {state:'IDLE',advances:i};
    }
    let run:Run;
    try { run=kernel.claim(work.id,work.revision); }
    catch(e:unknown) { const m=errorMessage(e); if (m==='STALE_REVISION'||m==='CLAIM_LOST') continue; throw e; }
    let outcome:ExecuteOutcome;
    try { outcome=await execute(work.packet,run); }
    catch(e:unknown) { outcome={kind:'execution-error',error:errorMessage(e),may_have_mutated:true}; }
    if (outcome.kind==='judgment-required') {
      kernel.deferForJudgment(run.id,{outcome});
      return {state:'WAITING',work:work.id,run:run.id,advances:i+1};
    }
    const receipt=kernel.resolve(run.id);
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') continue;
    return {state:'RECOVERY_REQUIRED',work:work.id,run:run.id,advances:i+1};
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
