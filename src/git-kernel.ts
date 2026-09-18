import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const STATE_REF = 'refs/overcenter/state';
const STATE_SCHEMA = 'overcenter-git-state-v3';
const RECEIPT_SCHEMA = 'overcenter-git-receipt-v2';

type StoredWorkStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type WorkStatus = StoredWorkStatus | 'BLOCKED';
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
  verified: boolean;
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

export interface Obligation {
  id: string;
  deps: string[];
  packet: Data;
  postcondition: Postcondition;
  status: StoredWorkStatus;
  run_id?: string;
  claimed_revision?: string;
  claim_commit?: string;
}
interface State { schema: typeof STATE_SCHEMA; obligations: Record<string, Obligation> }
export interface Work extends Omit<Obligation, 'status'> {
  status: WorkStatus;
  revision: string;
  blocked_reason?: string;
}
export interface Run { id: string; obligation_id: string; claimed_revision: string; claim_commit: string }
export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  run_id: string;
  obligation_id: string;
  claimed_revision?: string;
  claim_commit: string;
  disposition: Disposition;
  verified: boolean;
  observed: Observation | null;
  diagnostic?: Data;
  settled_at: string;
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
    const commit = this.#commit(null, this.#emptyState(), 'overcenter: initialize');
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

  define({ id, deps = [], packet = {}, postcondition }: { id: string; deps?: string[]; packet?: Data; postcondition: Postcondition }): string {
    this.#validatePostcondition(postcondition);
    const head = this.#requireHead();
    const state = this.#state(head);
    if (this.#hasInFlight(state)) throw new Error('PROJECT_BUSY');
    if (state.obligations[id]) throw new Error(`duplicate obligation: ${id}`);
    state.obligations[id] = { id, deps, packet, postcondition, status:'READY' };
    const commit = this.#commit(head, state, `overcenter: define ${id}`);
    if (!this.#cas(commit, head)) throw new Error('DEFINE_LOST');
    return commit;
  }

  inspect(): Work[] {
    const head = this.#requireHead();
    const state = this.#state(head);
    return Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work => this.#projectWork(state, work, head));
  }

  deriveReadyWork(): Work | null {
    const head = this.#requireHead();
    const state = this.#state(head);
    const work = Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .find(candidate => this.#claimabilityError(state, candidate)===null);
    return work ? this.#projectWork(state, work, head) : null;
  }

  claim(id: string, expectedRevision: string): Run {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');
    const state = this.#state(head);
    const work = state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const claimabilityError=this.#claimabilityError(state,work);
    if (claimabilityError) throw new Error(claimabilityError);
    const runId = randomUUID();
    work.status='EXECUTING'; work.run_id=runId; work.claimed_revision=head;
    const commit = this.#commit(head,state,`overcenter: claim ${id} ${runId}`);
    if (!this.#cas(commit,head)) throw new Error('CLAIM_LOST');
    return {id:runId, obligation_id:id, claimed_revision:head, claim_commit:commit};
  }

  resolve(runId: string): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head = this.#requireHead();
      const state = this.#state(head);
      const work = Object.values(state.obligations).find(candidate => candidate.run_id===runId);
      if (!work) {
        const prior = this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('UNKNOWN_RUN');
      }
      if (!['EXECUTING','RECOVERY_REQUIRED','WAITING'].includes(work.status)) {
        const prior = this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('NOT_RESOLVABLE');
      }

      const claimCommit = work.claim_commit ?? this.#findClaimCommit(runId, work, head);
      const observed = this.#observe(work.postcondition);
      const disposition: Disposition = observed.verified
        ? 'DONE'
        : observed.mutation_certainty === 'absent'
          ? 'READY'
          : 'RECOVERY_REQUIRED';
      const receipt = this.#receipt(runId,work,disposition,observed.verified,observed,claimCommit);
      work.status=disposition;
      work.claim_commit=claimCommit;
      if (disposition==='READY') {
        delete work.run_id;
        delete work.claimed_revision;
        delete work.claim_commit;
      }
      const commit=this.#commit(head,state,`overcenter: resolve ${work.id} ${disposition}`,receipt);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  defer(runId: string, disposition: 'WAITING'|'RECOVERY_REQUIRED', diagnostic: Data = {}): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head=this.#requireHead();
      const state=this.#state(head);
      const work=Object.values(state.obligations).find(candidate=>candidate.run_id===runId);
      if (!work) {
        const prior=this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('UNKNOWN_RUN');
      }
      if (work.status!=='EXECUTING') {
        const prior=this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      const claimCommit=this.#findClaimCommit(runId,work,head);
      work.claim_commit=claimCommit;
      work.status=disposition;
      const receipt=this.#receipt(runId,work,disposition,false,null,claimCommit,diagnostic);
      const commit=this.#commit(head,state,`overcenter: defer ${work.id} ${disposition}`,receipt);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recoverInterrupted(runId: string, diagnostic: Data = {}): Receipt {
    for (let attempt=0; attempt<16; attempt+=1) {
      const head=this.#requireHead();
      const state=this.#state(head);
      const work=Object.values(state.obligations).find(candidate=>candidate.run_id===runId);
      if (!work) {
        const prior=this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('UNKNOWN_RUN');
      }
      if (work.status!=='EXECUTING') {
        const prior=this.receipts(runId).at(-1);
        if (prior) return prior;
        throw new Error('RUN_NOT_EXECUTING');
      }
      const claimCommit=this.#findClaimCommit(runId,work,head);
      work.claim_commit=claimCommit;
      work.status='RECOVERY_REQUIRED';
      const receipt=this.#receipt(
        runId,
        work,
        'RECOVERY_REQUIRED',
        false,
        null,
        claimCommit,
        {reason:'execution-terminated',...diagnostic},
      );
      const commit=this.#commit(head,state,`overcenter: recover ${work.id} ${runId}`,receipt);
      if (this.#cas(commit,head)) return {...receipt, settlement_commit:commit};
    }
    throw new Error('RECOVERY_CONTENTION_EXHAUSTED');
  }

  reconcile(runId: string): Receipt { return this.resolve(runId); }

  receipts(runId: string | null = null): Receipt[] {
    const head=this.#requireHead();
    const revs=this.#git(['rev-list','--reverse',head]).stdout.trim().split(/\n+/).filter(Boolean);
    const out: Receipt[]=[];
    for (const commit of revs) {
      const file=this.#git(['show',`${commit}:receipt.json`],{allowFailure:true});
      if (!file.ok) continue;
      const receipt=JSON.parse(file.stdout) as Receipt;
      if (!runId || receipt.run_id===runId) out.push({...receipt,settlement_commit:commit});
    }
    return out;
  }

  #requireHead(): string { const head=this.head(); if (!head) throw new Error('NOT_INITIALIZED'); return head; }
  #emptyState(): State { return {schema:STATE_SCHEMA,obligations:{}}; }
  #hasInFlight(state: State): boolean {
    return Object.values(state.obligations).some(work=>IN_FLIGHT.has(work.status));
  }
  #effectSemantics(
    postcondition: Postcondition,
  ): { resource: string; desired: string; sameDesiredCommutes: boolean } | null {
    if (postcondition.verifier!=='github-commit-status/v1') return null;
    return {
      resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${postcondition.context}`,
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
  #claimabilityError(state: State, work: Obligation): string | null {
    if (work.status!=='READY') return 'NOT_READY';
    const done=new Set(
      Object.values(state.obligations)
        .filter(candidate=>candidate.status==='DONE')
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
  #projectWork(state: State, work: Obligation, revision: string): Work {
    const projected={...structuredClone(work),revision} as Work;
    if (work.status!=='READY') return projected;
    const reason=this.#claimabilityError(state,work);
    if (reason && reason!=='NOT_READY' && reason!=='DEPENDENCIES_NOT_DONE') {
      projected.status='BLOCKED';
      projected.blocked_reason=reason;
    }
    return projected;
  }
  #findClaimCommit(runId: string, work: Obligation, head: string): string {
    if (!work.claimed_revision) throw new Error('MISSING_CLAIMED_REVISION');
    const revs=this.#git(['rev-list','--reverse',head,`^${work.claimed_revision}`]).stdout
      .trim()
      .split(/\n+/)
      .filter(Boolean);
    for (const commit of revs) {
      const candidate=this.#state(commit).obligations[work.id];
      if (candidate?.run_id===runId && candidate.status==='EXECUTING') return commit;
    }
    throw new Error('CLAIM_COMMIT_NOT_FOUND');
  }
  #state(commit: string): State {
    const state=JSON.parse(this.#git(['show',`${commit}:state.json`]).stdout) as State;
    if (state.schema!==STATE_SCHEMA) throw new Error('INVALID_STATE_SCHEMA'); return state;
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
          verified:false,
          observation_error:'GITHUB_TOKEN_UNAVAILABLE',
        };
      }
      try {
        const repository=this.#githubGet(`/repositories/${p.repository_id}`) as { id?: number; full_name?: string };
        if (repository.id!==p.repository_id || typeof repository.full_name!=='string') {
          throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
        }
        const statuses=this.#githubGet(
          `/repos/${repository.full_name}/commits/${p.commit_sha}/statuses?per_page=100`,
        ) as Array<{ context?: string; state?: string }>;
        const status=statuses.find(candidate=>candidate.context===p.context);
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
            verified:false,
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
          verified:status.state===p.expected_state,
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
          verified:false,
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
          verified:false,
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
          verified:false,
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
        verified:actualSha===p.target_sha,
      };
    }

    const expected=sha256(p.content);
    try {
      const actual=readFileSync(p.path,'utf8');
      const actualSha=sha256(actual);
      return {verifier:p.verifier,path:p.path,expected_sha256:expected,actual_sha256:actualSha,mutation_certainty:'present',verified:actual===p.content};
    } catch (e: unknown) {
      const code=(e as {code?:string}).code;
      if (code==='ENOENT') return {verifier:p.verifier,path:p.path,expected_sha256:expected,mutation_certainty:'absent',verified:false};
      return {verifier:p.verifier,path:p.path,expected_sha256:expected,mutation_certainty:'uncertain',verified:false,observation_error:errorMessage(e)};
    }
  }
  #receipt(runId:string,work:Obligation,disposition:Disposition,verified:boolean,observed:Observation|null,claimCommit:string,diagnostic?:Data): Receipt {
    return {schema:RECEIPT_SCHEMA,run_id:runId,obligation_id:work.id,claimed_revision:work.claimed_revision,claim_commit:claimCommit,disposition,verified,observed,...(diagnostic?{diagnostic}:{}),settled_at:new Date().toISOString()};
  }
  #commit(parent:string|null,state:State,message:string,receipt:Receipt|null=null): string {
    const entries:Array<[string,string]>=[['state.json',this.#blob(json(state))]];
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
      kernel.defer(run.id,'WAITING',{outcome});
      return {state:'WAITING',work:work.id,run:run.id,advances:i+1};
    }
    const receipt=kernel.resolve(run.id);
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') continue;
    return {state:'RECOVERY_REQUIRED',work:work.id,run:run.id,advances:i+1};
  }
  return {state:'BUDGET_EXHAUSTED',advances:maxAdvances};
}
