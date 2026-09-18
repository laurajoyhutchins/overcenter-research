import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STATE_REF = 'refs/overcenter/state';
const STATE_SCHEMA = 'overcenter-git-state-v1';
const RECEIPT_SCHEMA = 'overcenter-git-receipt-v1';

type WorkStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type Disposition = 'DONE' | 'READY' | 'WAITING' | 'RECOVERY_REQUIRED';
export type MutationCertainty = 'present' | 'absent' | 'uncertain';
export type Data = Record<string, any>;
export type Verify = (postcondition: Data, observed: Observation) => boolean;

export interface Observation extends Data {
  mutation_certainty?: MutationCertainty;
}

export interface Obligation {
  id: string;
  deps: string[];
  packet: Data;
  postcondition: Data;
  status: WorkStatus;
  run_id?: string;
  claimed_revision?: string;
  claim_commit?: string;
}

interface ActiveRun {
  id: string;
  obligation_id: string;
  claimed_revision: string;
}

interface State {
  schema: typeof STATE_SCHEMA;
  obligations: Record<string, Obligation>;
  active_run: ActiveRun | null;
}

export interface Work extends Obligation {
  revision: string;
}

export interface Run {
  id: string;
  obligation_id: string;
  claimed_revision: string;
  claim_commit: string;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  run_id: string;
  obligation_id: string;
  claimed_revision?: string;
  claim_commit: string;
  disposition: Disposition;
  verified: boolean;
  observed: Observation;
  settled_at: string;
  settlement_commit?: string;
}

export interface ExecuteOutcome extends Data {
  kind?: string;
  may_have_mutated?: boolean;
}

export interface LoopOptions {
  execute: (packet: Data, run: Run) => Promise<ExecuteOutcome>;
  observe: (work: Work, run: Run, outcome: ExecuteOutcome) => Promise<Observation>;
  verify: Verify;
  maxAdvances?: number;
}

export interface LoopResult {
  state: 'IDLE' | 'RECOVERY_REQUIRED' | 'WAITING' | 'BUDGET_EXHAUSTED';
  advances: number;
  work?: string;
  run?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

const TERMINAL_BLOCKERS = new Set<WorkStatus>(['EXECUTING', 'WAITING', 'RECOVERY_REQUIRED']);

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitOvercenterKernel {
  readonly repo: string;
  readonly ref: string;

  constructor(repo: string, { ref = STATE_REF }: { ref?: string } = {}) {
    this.repo = repo;
    this.ref = ref;
    this.#git(['rev-parse', '--git-dir']);
  }

  initialize(): string {
    const existing = this.head();
    if (existing) return existing;
    const commit = this.#commit(null, this.#emptyState(), 'overcenter: initialize');
    const zero = '0'.repeat(this.#objectIdLength());
    if (this.#updateRef(commit, zero)) return commit;

    const winner = this.head();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#state(winner);
    return winner;
  }

  head(): string | null {
    const result = this.#git(['rev-parse', '-q', '--verify', this.ref], { allowFailure: true });
    return result.ok ? result.stdout.trim() : null;
  }

  define({
    id,
    deps = [],
    packet = {},
    postcondition,
  }: {
    id: string;
    deps?: string[];
    packet?: Data;
    postcondition: Data;
  }): string {
    const head = this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    const state = this.#state(head);
    if (state.active_run || this.#hasBlocker(state)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);
    state.obligations[id] = { id, deps, packet, postcondition, status: 'READY' };
    const commit = this.#commit(head, state, `overcenter: define ${id}`);
    if (!this.#updateRef(commit, head)) throw new Error('DEFINE_LOST');
    return commit;
  }

  inspect(): Work[] {
    const head = this.head();
    if (!head) return [];
    return Object.values(this.#state(head).obligations)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(work => ({ ...structuredClone(work), revision: head }));
  }

  deriveReadyWork(): Work | null {
    const head = this.head();
    if (!head) return null;
    const state = this.#state(head);
    if (state.active_run || this.#hasBlocker(state)) return null;
    const done = new Set(
      Object.values(state.obligations)
        .filter(work => work.status === 'DONE')
        .map(work => work.id),
    );
    const work = Object.values(state.obligations)
      .sort((a, b) => a.id.localeCompare(b.id))
      .find(candidate => candidate.status === 'READY' && candidate.deps.every(dep => done.has(dep)));
    return work ? { ...structuredClone(work), revision: head } : null;
  }

  claim(id: string, expectedRevision: string): Run {
    const head = this.head();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');
    const state = this.#state(head);
    if (state.active_run || this.#hasBlocker(state)) throw new Error('PROJECT_BUSY');
    const work = state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    if (work.status !== 'READY') throw new Error('NOT_READY');
    const done = new Set(
      Object.values(state.obligations)
        .filter(candidate => candidate.status === 'DONE')
        .map(candidate => candidate.id),
    );
    if (!work.deps.every(dep => done.has(dep))) throw new Error('DEPENDENCIES_NOT_DONE');

    const runId = randomUUID();
    work.status = 'EXECUTING';
    work.run_id = runId;
    work.claimed_revision = head;
    state.active_run = { id: runId, obligation_id: id, claimed_revision: head };
    const commit = this.#commit(head, state, `overcenter: claim ${id} ${runId}`);
    if (!this.#updateRef(commit, head)) throw new Error('CLAIM_LOST');
    return { id: runId, obligation_id: id, claimed_revision: head, claim_commit: commit };
  }

  settle(
    runId: string,
    {
      disposition,
      observed = {},
      verify = null,
    }: {
      disposition: Disposition;
      observed?: Observation;
      verify?: Verify | null;
    },
  ): Receipt {
    const head = this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    const state = this.#state(head);
    if (!state.active_run || state.active_run.id !== runId) {
      const prior = this.receipts(runId).at(-1);
      if (prior) return prior;
      throw new Error('UNKNOWN_RUN');
    }
    const work = state.obligations[state.active_run.obligation_id];
    if (!work || work.status !== 'EXECUTING' || work.run_id !== runId) throw new Error('AUTHORITY_LOST');

    const verified = disposition === 'DONE'
      ? Boolean(verify?.(work.postcondition, observed))
      : false;
    if (disposition === 'DONE' && !verified) throw new Error('UNVERIFIED_DONE');
    if (disposition === 'READY' && observed.mutation_certainty !== 'absent') {
      throw new Error('REPLAY_SAFETY_UNPROVEN');
    }

    work.claim_commit = head;
    const receipt = this.#receipt(runId, work, disposition, verified, observed, head);
    work.status = disposition;
    if (disposition === 'READY') {
      delete work.run_id;
      delete work.claimed_revision;
      delete work.claim_commit;
    }
    state.active_run = null;
    const commit = this.#commit(head, state, `overcenter: settle ${work.id} ${disposition}`, receipt);
    if (!this.#updateRef(commit, head)) throw new Error('AUTHORITY_LOST');
    return { ...receipt, settlement_commit: commit };
  }

  recoverInterrupted(): number {
    const head = this.head();
    if (!head) return 0;
    const state = this.#state(head);
    if (!state.active_run) return 0;
    const run = state.active_run;
    const work = state.obligations[run.obligation_id];
    if (!work || work.status !== 'EXECUTING' || work.run_id !== run.id) throw new Error('CORRUPT_ACTIVE_RUN');

    const observed: Observation = { mutation_certainty: 'uncertain', reason: 'interrupted execution' };
    work.claim_commit = head;
    const receipt = this.#receipt(run.id, work, 'RECOVERY_REQUIRED', false, observed, head);
    work.status = 'RECOVERY_REQUIRED';
    state.active_run = null;
    const commit = this.#commit(head, state, `overcenter: recover ${work.id} ${run.id}`, receipt);
    if (!this.#updateRef(commit, head)) throw new Error('RECOVERY_LOST');
    return 1;
  }

  reconcile(runId: string, observed: Observation, verify: Verify): Receipt {
    const head = this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    const state = this.#state(head);
    if (state.active_run) throw new Error('PROJECT_BUSY');
    const work = Object.values(state.obligations).find(candidate => candidate.run_id === runId);
    if (!work) {
      const prior = this.receipts(runId).at(-1);
      if (prior?.disposition === 'DONE') return prior;
      throw new Error('UNKNOWN_RUN');
    }
    if (!['RECOVERY_REQUIRED', 'WAITING'].includes(work.status)) {
      const prior = this.receipts(runId).at(-1);
      if (prior) return prior;
      throw new Error('NOT_RECONCILABLE');
    }

    const verified = Boolean(verify(work.postcondition, observed));
    const disposition: Disposition = verified
      ? 'DONE'
      : observed.mutation_certainty === 'absent'
        ? 'READY'
        : 'RECOVERY_REQUIRED';
    if (!work.claim_commit) throw new Error('MISSING_CLAIM_IDENTITY');
    const receipt = this.#receipt(runId, work, disposition, verified, observed, work.claim_commit);
    work.status = disposition;
    if (disposition === 'READY') {
      delete work.run_id;
      delete work.claimed_revision;
      delete work.claim_commit;
    }
    const commit = this.#commit(head, state, `overcenter: reconcile ${work.id} ${disposition}`, receipt);
    if (!this.#updateRef(commit, head)) throw new Error('RECONCILE_LOST');
    return { ...receipt, settlement_commit: commit };
  }

  receipts(runId: string | null = null): Receipt[] {
    const head = this.head();
    if (!head) return [];
    const revs = this.#git(['rev-list', '--reverse', head]).stdout.trim().split(/\n+/).filter(Boolean);
    const receipts: Receipt[] = [];
    for (const commit of revs) {
      const file = this.#git(['show', `${commit}:receipt.json`], { allowFailure: true });
      if (!file.ok) continue;
      const receipt = JSON.parse(file.stdout) as Receipt;
      if (!runId || receipt.run_id === runId) receipts.push({ ...receipt, settlement_commit: commit });
    }
    return receipts;
  }

  #emptyState(): State {
    return { schema: STATE_SCHEMA, obligations: {}, active_run: null };
  }

  #hasBlocker(state: State): boolean {
    return Object.values(state.obligations).some(work => TERMINAL_BLOCKERS.has(work.status));
  }

  #state(commit: string): State {
    const state = JSON.parse(this.#git(['show', `${commit}:state.json`]).stdout) as State;
    if (state.schema !== STATE_SCHEMA) throw new Error('INVALID_STATE_SCHEMA');
    return state;
  }

  #receipt(
    runId: string,
    work: Obligation,
    disposition: Disposition,
    verified: boolean,
    observed: Observation,
    claimCommit: string,
  ): Receipt {
    return {
      schema: RECEIPT_SCHEMA,
      run_id: runId,
      obligation_id: work.id,
      claimed_revision: work.claimed_revision,
      claim_commit: claimCommit,
      disposition,
      verified,
      observed,
      settled_at: new Date().toISOString(),
    };
  }

  #commit(parent: string | null, state: State, message: string, receipt: Receipt | null = null): string {
    const entries: Array<[string, string]> = [['state.json', this.#blob(json(state))]];
    if (receipt) entries.push(['receipt.json', this.#blob(json(receipt))]);
    const treeInput = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sha]) => `100644 blob ${sha}\t${name}\n`)
      .join('');
    const tree = this.#git(['mktree'], { input: treeInput }).stdout.trim();
    const args = ['commit-tree', tree];
    if (parent) args.push('-p', parent);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Overcenter Kernel',
      GIT_AUTHOR_EMAIL: 'overcenter@local',
      GIT_COMMITTER_NAME: 'Overcenter Kernel',
      GIT_COMMITTER_EMAIL: 'overcenter@local',
    };
    return this.#git(args, { input: `${message}\n`, env }).stdout.trim();
  }

  #blob(content: string): string {
    return this.#git(['hash-object', '-w', '--stdin'], { input: content }).stdout.trim();
  }

  #updateRef(next: string, expected: string): boolean {
    return this.#git(['update-ref', this.ref, next, expected], { allowFailure: true }).ok;
  }

  #objectIdLength(): number {
    return this.#git(['rev-parse', '--show-object-format']).stdout.trim() === 'sha256' ? 64 : 40;
  }

  #git(
    args: string[],
    {
      input = undefined,
      env = process.env,
      allowFailure = false,
    }: {
      input?: string;
      env?: Record<string, string | undefined>;
      allowFailure?: boolean;
    } = {},
  ): GitResult {
    try {
      const stdout = execFileSync('git', ['-C', this.repo, ...args], {
        input,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, stdout };
    } catch (error) {
      const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      if (allowFailure) {
        return {
          ok: false,
          stdout: String(failure.stdout ?? ''),
          stderr: String(failure.stderr ?? ''),
        };
      }
      throw new Error(`git ${args.join(' ')} failed: ${String(failure.stderr ?? failure.message ?? '').trim()}`);
    }
  }
}

export async function runGitCoreLoop(
  kernel: GitOvercenterKernel,
  { execute, observe, verify, maxAdvances = 100 }: LoopOptions,
): Promise<LoopResult> {
  if (!kernel.head()) throw new Error('NOT_INITIALIZED');
  for (let i = 0; i < maxAdvances; i += 1) {
    const work = kernel.deriveReadyWork();
    if (!work) return { state: 'IDLE', advances: i };

    let run: Run;
    try {
      run = kernel.claim(work.id, work.revision);
    } catch (error) {
      const message = errorMessage(error);
      if (message === 'STALE_REVISION' || message === 'CLAIM_LOST') continue;
      throw error;
    }

    let outcome: ExecuteOutcome;
    try {
      outcome = await execute(work.packet, run);
    } catch (error) {
      outcome = {
        kind: 'execution-error',
        error: errorMessage(error),
        may_have_mutated: true,
      };
    }

    let observed: Observation;
    try {
      observed = await observe(work, run, outcome);
    } catch (error) {
      observed = {
        mutation_certainty: 'uncertain',
        observation_error: errorMessage(error),
      };
      kernel.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed });
      return { state: 'RECOVERY_REQUIRED', work: work.id, run: run.id, advances: i + 1 };
    }

    let verified: boolean;
    try {
      verified = Boolean(verify(work.postcondition, observed));
    } catch (error) {
      const recoveryObservation: Observation = {
        ...observed,
        mutation_certainty: 'uncertain',
        verification_error: errorMessage(error),
      };
      kernel.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed: recoveryObservation });
      return { state: 'RECOVERY_REQUIRED', work: work.id, run: run.id, advances: i + 1 };
    }

    if (verified) {
      kernel.settle(run.id, { disposition: 'DONE', observed, verify });
      continue;
    }
    if (outcome.kind === 'judgment-required') {
      kernel.settle(run.id, { disposition: 'WAITING', observed });
      return { state: 'WAITING', work: work.id, run: run.id, advances: i + 1 };
    }
    if (observed.mutation_certainty === 'absent') {
      kernel.settle(run.id, { disposition: 'READY', observed });
      continue;
    }

    kernel.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed });
    return { state: 'RECOVERY_REQUIRED', work: work.id, run: run.id, advances: i + 1 };
  }
  return { state: 'BUDGET_EXHAUSTED', advances: maxAdvances };
}
