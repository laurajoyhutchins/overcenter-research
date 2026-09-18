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

For the consolidated architecture and research claims, start with:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — canonical architecture model and glossary;
- [`research/claims.md`](./research/claims.md) — safety, liveness, provenance, and reuse claims separated explicitly;
- [`research/durable-execution-comparison.md`](./research/durable-execution-comparison.md) — Temporal, Restate, DBOS, AWS, and what authoritative reconciliation adds beyond durable replay;
- [`research/README.md`](./research/README.md) — map of the detailed prior-art notes.

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

## Derived project projection

The Git kernel now treats lifecycle status as a projection instead of persisted
project state.

`state.json` schema v5 contains obligation definitions only:

```text
id
deps
packet
postcondition
```

It does **not** persist:

```text
status
run_id
claimed_revision
claim_commit
```

A successful claim writes an immutable `claim.json` fact in the exact claim
commit. That fact binds the run ID and obligation to the exact parent authority
revision. Evidence commits write `receipt.json` facts with one of three factual
event kinds:

```text
observation
judgment-required
execution-terminated
```

They do not persist `disposition`, `verified`, or an observation-level
`verified` bit. On every `inspect()`, `deriveReadyWork()`, claim, recovery, or
settlement operation, the kernel replays those durable facts from the current
authority history and derives the current projection:

```text
obligation definitions in state.json
              +
immutable claim.json facts
              +
durable receipt.json evidence
              ↓
READY / EXECUTING / WAITING / RECOVERY_REQUIRED / DONE
              +
dependency/effect projection
              ↓
BLOCKED where applicable
```

Replay verifies that claim commits are children of the revisions they claim to
fence and that receipts bind to the exact claim revision and claim commit.

The destructive projection test now runs against `GitOvercenterKernel` itself.
It uses a central bare Git authority and repeatedly:

```text
derive projection
      ↓
materialize cache
      ↓
DELETE cache
      ↓
create fresh disposable clone
      ↓
read current central authority
      ↓
derive again
      ↓
assert byte-identical projection + identical SHA-256
```

This is exercised across a two-obligation graph at READY/BLOCKED, EXECUTING,
unchanged provider-effect state, RECOVERY_REQUIRED, and DONE/READY boundaries.
The test also reads committed `state.json` directly and fails if any lifecycle or
claim-cache field reappears.

Run it directly with:

```bash
npm run test:projection
```

`receipt.json` schema v3 now records factual event/evidence only. The public
`Receipt` returned by the kernel still exposes `disposition` and `verified`
for caller convenience, but those values are reconstructed during replay from the
event kind, obligation predicate, and provider observation.

The judgment path follows the same rule. Callers invoke
`deferForJudgment(runId, evidence)`; they no longer request `WAITING`.
`WAITING` is projected from the durable `judgment-required` fact.

Raw-history tests fail if `disposition`, `verified`, or observation-level
`verified` reappear in committed receipts.

> Deleting every materialized project status must lose no project truth.

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
  statuses: write  # repository-scoped, not coordinate-scoped
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

The execution token cannot modify `refs/overcenter/state`. Its GitHub `statuses: write` permission is broader than the immutable obligation: GitHub scopes that permission at repository level, not to one SHA/context. The proof therefore establishes that Agent A cannot redefine project authority or settlement truth; it does **not** establish least-privilege provider mutation capability.

The external provider status is created only after Agent A has confirmed that its attempted authority rewrite was rejected and the canonical authority ref remains at the original claim commit.

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

Provider absence is never inferred from only the first GitHub status page. The verifier walks status pages until it either finds the target context or reaches an exhausted page. Hitting the safety page limit fails closed as uncertain rather than replayable absence. The hosted proof deliberately writes 100 newer distractor statuses after the target effect so trusted readback must cross the page-one boundary.

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

## Current concurrency boundary

The prototype no longer serializes all external effects.

Independent obligations can remain `EXECUTING` simultaneously, and independent recovery processes can settle through the same linear Git authority ref. The ref still serializes authoritative state updates through CAS; it does **not** require the external effects themselves to run one at a time.

For the canonical GitHub commit-status adapter, the kernel also models an effect-conflict domain:

```text
repository identity
+ exact commit
+ normalized status context
```

On one canonical coordinate:

- identical desired states are explicitly allowed to commute;
- incompatible desired states must be graph-ordered;
- unordered incompatible effects project as `BLOCKED` and cannot be claimed.

This is deliberately adapter-specific. The file and Git-ref proof adapters do not pretend to provide universal alias/conflict semantics for arbitrary external systems.

The remaining minimality constraint is therefore not "one effect at a time." It is:

> Add concurrency semantics only where the provider adapter can name the mutation coordinate and justify commutativity/conflict rules.

## Run it

Validated in the assistant sandbox with Node.js 22.16.0 and Git 2.47.3. The TypeScript path uses Node's built-in type stripping; there is no TypeScript compiler, loader, or package dependency.

```sh
npm test
npm run test:git
npm run test:handoff
npm run test:concurrency
npm run test:effect-order
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
- canonical GitHub repository-ID + exact-commit status readback settles independently of the executor's local Git configuration;
- two independent obligations can remain `EXECUTING` simultaneously without losing exact claim identity;
- two fresh recovery processes can settle independent effects through one CAS authority ref;
- canonical GitHub-status effect conflicts are blocked unless graph ordering makes the sequence explicit;
- identical desired GitHub statuses on the same canonical coordinate are explicitly modeled as commuting.

The proof suite is intentionally growing; the README does not pin a historical pass count. Run `npm test` for the current focused regression set and the dedicated scripts above for handoff, concurrency, effect-ordering, and stress experiments.

## Files

```text
src/kernel.js                 SQLite reference kernel
src/git-kernel.ts             Git authority kernel
examples/demo.js              SQLite demo
examples/git-demo.ts          Git-native demo
test/kernel.test.js           SQLite proofs
test/git-kernel.test.ts       Git kernel proofs
test/disposable-agent.test.ts disposable-agent handoff proof
test/two-effect-concurrency.test.ts independent-effect concurrency/recovery proofs
test/effect-ordering.test.ts  provider-coordinate conflict/commutativity proofs
stress/git-stress.ts          adversarial Git/clone stress tests
actions/project-authority.ts    trusted definition/claim boundary
actions/disposable-agent-a.ts  hosted disposable executor
actions/disposable-agent-b.ts  hosted recovery executor
.github/workflows/disposable-agent-proof.yml  live Actions proof
ARCHITECTURE.md               consolidated architecture + glossary
research/README.md            research map
research/claims.md            safety/liveness/provenance/reuse taxonomy
research/durable-execution-comparison.md durable-execution comparison
research/                     detailed prior-art notes
```

The experiment is intentionally small. New machinery should have to demonstrate that Git authority plus disposable local state cannot provide the required safety first.
