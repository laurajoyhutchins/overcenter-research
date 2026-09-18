# Overcenter Core Loop

This repository contains a deliberately minimal executable reference implementation of Overcenter's core idea:

```text
inspect authoritative state
        ↓
derive READY work
        ↓
claim @ exact revision
        ↓
execute uncertain action
        ↓
observe authoritative reality
        ↓
verify postcondition
        ↓
settle durable receipt
        ↓
recompute READY work ↺
```

The worker does **not** decide that its work succeeded.

## Two storage experiments

```text
src/kernel.js       SQLite-backed reference
src/git-kernel.ts   Git-backed prototype
```

The Git prototype asks whether the core loop can reduce durable shared authority to:

```text
immutable Git objects
        +
refs/overcenter/state
        +
CAS(expected SHA → new SHA)
```

For a local authority repository, CAS is `git update-ref <ref> <new> <expected>`.

For disposable agent clones, the same rule is enforced against the central authority with an exact leased push:

```text
git push \
  --force-with-lease=refs/overcenter/state:<expected-sha> \
  origin <new-sha>:refs/overcenter/state
```

The commit SHA is the authoritative state revision. Settlement and recovery commits carry `receipt.json`; older receipts remain reachable through Git history.

## Kernel-owned verification

Agents no longer supply an observation object or verifier function to settle work.

The obligation contains immutable verification semantics. The current deliberately tiny adapter is:

```ts
{
  verifier: 'file-content-equals/v1',
  path: '/authoritative/external/path',
  content: 'expected content'
}
```

`resolve(runId)` reads that external truth itself, hashes the expected and actual content, and deterministically chooses:

```text
matches expected       → DONE
authoritatively absent → READY
anything else          → RECOVERY_REQUIRED
```

So this is no longer possible:

```ts
settle(run.id, {
  disposition: 'DONE',
  observed: fabricatedEvidence,
  verify: () => true,
});
```

There is no caller-provided `DONE` verifier path.

The file-content verifier is intentionally only a local proof adapter, not a proposed universal evidence model.

The branch now has two cross-sandbox/provider proof adapters.

The earlier `git-ref-equals/v1` adapter proved hosted Git ref readback. The hardened adapter removes sandbox-local remote aliases entirely:

```ts
{
  verifier: 'github-commit-status/v1',
  provider: 'github',
  repository_id: 1354872053,
  commit_sha: '<exact input commit>',
  context: 'overcenter/trust-proof/<workflow>/<attempt>',
  expected_state: 'success'
}
```

The numeric GitHub repository ID, exact commit, status context, and expected state are committed before the execution agent starts. The trusted verifier resolves the repository ID through fixed `api.github.com` and reads provider state from that canonical repository. Local Git configuration does not participate in verification.

## Disposable-agent handoff

The strongest experiment in this branch is:

```text
central Git authority
        │
        ▼
fresh Agent A clone
        │
        ▼
claim exact run
        │
        ▼
perform external effect
        │
        X
delete Agent A repo, cache, DB, process memory
        │
        ▼
durable supervisor fact: run A terminated
        │
        ▼
fresh Agent B clone
        │
        ▼
reconstruct unresolved run from Git
        │
        ▼
observe external truth
        │
        ▼
reconcile same run
        │
        ▼
verified DONE
```

Agent B receives nothing from Agent A's local database or filesystem.

The test even creates a fake `agent-cache.sqlite` inside A's sandbox and then deletes the entire sandbox before B exists. Project truth survives because the claim was already committed to central Git authority.

The supervisor contributes only a termination fact for the exact run ID. `recoverInterrupted(runId)` refuses to recover a different active run.

This is the current boundary:

```text
Git owns:
  durable state
  exact identity
  history
  CAS
  receipts
  reconstruction

execution platform owns:
  "sandbox/run X has terminated"
```

No shared SQL database is required by the experiment.

## Live GitHub Actions proof

The disposable-agent model has now been exercised on GitHub-hosted runners, not only local bare repositories.

Workflow run `35303766455` used two different hosted VMs:

```text
Agent A job
  fresh checkout
  initialize/fetch refs/overcenter/state
  claim exact run via leased remote CAS
  create GitHub effect ref
  read effect ref back
  exit 86 without settlement
        │
        ▼
GitHub records Agent A step outcome = failure
Agent A job ends and its runner is discarded
        │
        ▼
Agent B job
  fresh checkout on a different runner
  receive only GitHub's recorded failure outcome
  reconstruct unresolved run from refs/overcenter/state
  recover exact run
  read provider ref independently
  settle verified DONE
```

No Agent A run ID, cache, worktree, artifact, SQLite database, or process memory is passed to Agent B. Agent B finds the Overcenter run identity in Git authority.

The hosted repository accepted the custom authority ref and exact leased updates to it. After the proof:

- `refs/overcenter/state` points to settlement commit `ae574663ed1ec321ae1121a48fe92019c5eed006`;
- the external effect ref `refs/tags/overcenter-actions-effect-35303766455-1` points to source commit `835b974ada11d498d84ce4cab957addfb26517a6`;
- the recovery commit is `175dbfec7219dbe9c33904b49f609d79b11add25`;
- the original claim commit is `d9f2c9a20b37c2da757c0988678d61768c05e70a`;
- the exact Overcenter run is `bc85b322-4fa7-4fb1-a8da-3f72f1b13803`.

The recovery receipt records:

```text
source: github-actions-job-supervisor
workflow_run_id: 35303766455
workflow_run_attempt: 1
job: agent-a
outcome: failure
```

The following settlement receipt independently records matching expected and actual GitHub provider SHAs and `verified: true`.

The overall Actions workflow concludes successfully because the deliberate Agent A process failure is treated as an observed lifecycle event rather than a failed proof.

## Hardened trust-boundary proof

A later hosted proof separates obligation authority from execution authority and treats the executor sandbox as potentially hostile.

Workflow run `35304838786` uses three different GitHub-hosted jobs with distinct token permissions:

```text
trusted project authority
  contents: write
       │
       ├─ define immutable obligation
       └─ claim exact snapshot
       │
       ▼
potentially untrusted Agent A
  contents: read
  statuses: write
       │
       ├─ repoint local origin
       ├─ rewrite local state ref
       ├─ replace local kernel source
       ├─ create fake SQLite cache
       ├─ attempt authoritative ref rewrite
       │      └─ rejected by GitHub permissions
       ├─ verify canonical authority did not move
       ├─ write only the bounded commit-status effect
       └─ terminate
       │
       ▼
trusted recovery / settlement
  contents: write
  statuses: read
       │
       ├─ reconstruct exact run from Git
       ├─ record supervisor termination fact
       ├─ resolve canonical repository_id via api.github.com
       ├─ read exact commit status
       └─ settle DONE via Git CAS
```

The execution token cannot modify `refs/overcenter/state`. The external provider status is created only after Agent A has confirmed that its attempted authority rewrite was rejected and the canonical authority ref remains at the original claim commit.

Final evidence for that run:

```text
workflow head:
b0add388e13933de643d1ecbe7a9f0ac47200e43

Overcenter run:
03fd76fa-9213-4b30-9411-8b34a5da68ea

claim:
349c2eebcb079378a22bbd16bbf54ee25d1f2391

recovery:
0b4070019b46252ccdbefa78fce7b32bea0f8833

settlement / authority:
61a763dbe43af85f90bbfb1356427f3050b29ce1

canonical repository_id:
1354872053

exact input:
b0add388e13933de643d1ecbe7a9f0ac47200e43

provider context:
overcenter/trust-proof/35304838786/1

provider state:
success
```

The settlement receipt records `github-commit-status/v1`, the canonical repository ID, the exact input SHA, matching status context, `actual_state: success`, and `verified: true`.

This proves the worker does not control the definition of success, the authority coordinate used to verify it, or the exact input identity used for settlement.

## Fail-closed authority

Missing authority is not empty state.

If `refs/overcenter/state` disappears, all observational surfaces fail with `NOT_INITIALIZED`, including:

- `inspect()`
- `deriveReadyWork()`
- `receipts()`
- `recoverInterrupted()`

A disposable agent cannot confuse "I cannot see project truth" with "there is no work."

## Lost acknowledgement

Settlement and reconciliation are idempotent by run identity.

If reconciliation commits `READY` or `DONE` but its response is lost, repeating `reconcile(runId)` returns the existing durable receipt instead of reporting `UNKNOWN_RUN`.

## Current deliberate constraint

The prototype permits only **one active external effect at a time**.

That keeps one linear authoritative ref sufficient. Parallel graph execution, leases, PostgreSQL, and distributed heartbeat machinery remain deliberately absent until an experiment demonstrates they are required.

## Run it

Validated in the assistant sandbox with Node.js 22.16.0 and Git 2.47.3. The TypeScript path uses Node's built-in type stripping; there is no TypeScript compiler, loader, or package dependency.

```sh
npm test
npm run test:git
npm run test:handoff
npm run test:stress
npm run demo:git
```

Equivalent direct execution:

```sh
node --experimental-strip-types examples/git-demo.ts
```

## Current proof set

The sandbox validation covers:

- exact-revision claim ancestry;
- kernel-owned postcondition observation;
- kernel-owned Git-provider ref observation;
- wrong-but-real effects cannot become `DONE` or `READY`;
- only authoritative absence permits replay;
- stale-revision fencing;
- exact-run interrupted recovery;
- idempotent `DONE` and `READY` reconciliation after lost acknowledgement;
- missing authority fails closed on every read surface;
- ref-lock failure cannot partially claim;
- aggressive Git GC;
- SHA-256 repositories;
- 16 independent disposable clones contending on one central authority, with exactly one claim;
- complete destruction of Agent A followed by successful reconstruction and settlement by fresh Agent B;
- a live GitHub Actions handoff across two hosted runners with GitHub itself supplying the lifecycle fact and provider readback;
- a hardened three-job proof where a separately authorized project authority defines and claims immutable intent before an execution agent with no Contents write permission starts;
- executor sandbox tampering with Git config, local state, kernel source, and cache cannot alter project truth or verifier authority;
- canonical GitHub repository-ID + exact-commit status readback settles independently of the executor's local Git configuration.

The combined focused, handoff, and stress suites passed **17/17** in the sandbox before being committed.

## Files

```text
src/kernel.js                 SQLite reference kernel
src/git-kernel.ts             Git authority kernel
examples/demo.js              SQLite demo
examples/git-demo.ts          Git-native demo
test/kernel.test.js           SQLite proofs
test/git-kernel.test.ts       Git kernel proofs
test/disposable-agent.test.ts disposable-agent handoff proof
stress/git-stress.ts          adversarial Git/clone stress tests
actions/project-authority.ts    trusted definition/claim boundary
actions/disposable-agent-a.ts  hosted disposable executor
actions/disposable-agent-b.ts  hosted recovery executor
.github/workflows/disposable-agent-proof.yml  live Actions proof
research/                     prior research
```

The experiment is intentionally small. New machinery should have to demonstrate that Git authority plus disposable local state cannot provide the required safety first.
