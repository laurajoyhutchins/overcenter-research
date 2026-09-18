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
experiments/sqlite-baseline/kernel.js  SQLite-backed baseline experiment
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

## Reconstructed project projection

The Git authority no longer contains a privileged current-state document.

Obligation structure is recorded as immutable `overcenter-git-obligation-v3` `obligation.json` facts:

```text
defined
  full obligation definition

amended
  full replacement definition
  exact previous definition commit
```

Each current obligation definition contains:

```text
id
dependencies
packet
postcondition
```

There are only two primitive dependency semantics:

```text
control
  upstream completion constrains executability
  upstream identity does not contribute to downstream meaning

semantic
  a selector resolves an exact upstream identity
  that selected identity contributes to the downstream obligation key
```

The current tiny selector set is:

```text
output / verified-content
evidence / settlement-receipt
```

Artifact, provider, evidence, approval, and provenance distinctions therefore do
not need separate primitive edge types. They belong in the semantic selector
contract when they affect downstream meaning.

Claims use `overcenter-git-claim-v2`. An immutable `claim.json` binds:

```text
run identity
obligation identity
exact parent authority revision
exact semantic obligation_key
```

The obligation key is derived from the obligation's own semantic specification
plus the selected identities of semantic dependencies. Control edges are excluded.

For content-selected dependencies, producer labels are also excluded: if two
upstream logical nodes provide the same exact selected content identity, a
downstream realization may be reused. If producer provenance matters, the
downstream obligation must select provenance/evidence identity instead of content
identity.

Evidence commits carry factual `receipt.json` events:

```text
observation
judgment-required
execution-terminated
```

No authority commit contains `state.json`. Durable receipts do not persist
`disposition`, `verified`, or an observation-level `verified` bit.

The kernel reconstructs current project truth by replaying Git history:

```text
obligation.json facts
        +
claim.json facts with exact obligation_key
        +
receipt.json evidence
        ↓
historical obligation generations + realizations
        ↓
derive current obligation keys
        ↓
matching historical DONE realization?
       /                         \
     yes                         no
      ↓                           ↓
     DONE                    READY / BLOCKED
```

Amendment does not write invalidation records and does not rewrite descendant
lifecycle state. It appends a new definition. Replay recomputes the affected
semantic identities and reuses historical realizations wherever the exact current
obligation key still matches.

This gives the intended incremental behavior:

```text
A changes
   ↓
recompute semantic consumer B
   ↓
selected identity changed?
   ├─ yes → B gets a different obligation key
   └─ no  → reuse B's existing realization

only a changed B identity can force semantic consumers of B to reconsider
```

Historical truth remains stable. A run is interpreted against the obligation
generation and exact `obligation_key` that were authoritative when it was
claimed. A later amendment cannot retroactively reinterpret its receipt.

Structural replay validates unknown dependencies, dependency cycles, exact
amendment ancestry, claim revision fencing, claim obligation-key binding,
receipt-to-claim identity, legal lifecycle transitions, and active-run amendment
fencing.

The adversarial dependency suite proves, among other cases:

- control changes do not poison downstream semantic identity;
- semantic changes invalidate only when selected identity changes;
- invalidation stops when an intermediary selected identity remains unchanged;
- control-to-semantic reclassification creates new meaning;
- edge declaration order does not alter semantic identity;
- equivalent content can be reused across different producer nodes;
- hidden undeclared dependencies remain outside the derivation model;
- active exact runs still fence amendment.

The destructive projection test runs against `GitOvercenterKernel` itself using
a central bare Git authority. At each lifecycle boundary it:

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
replay facts
      ↓
assert byte-identical projection + identical SHA-256
```

Raw-history tests fail if `state.json` appears in any authority commit, if
interpreted lifecycle fields leak into receipts, or if a semantic claim omits its
durable obligation key.

Run the focused proofs directly with:

```bash
npm run test:projection
npm run test:dependency-edges
```

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

### Hostile eventually consistent readback

The executable hostile-readback experiment models a provider whose write path can succeed before its read model converges:

```ts
{
  verifier: 'eventually-consistent-file-content-equals/v1',
  path: '/provider/read-model/resource-42',
  content: 'created'
}
```

For this provider class, missing or stale non-matching reads are not authoritative negative evidence. They remain `uncertain`, keep the exact run in `RECOVERY_REQUIRED`, and cannot release replayable `READY` work. Only positive convergence can settle the run `DONE`. See `research/eventually-consistent-readback-experiment.md`.


The hosted provider proof uses canonical GitHub commit-status readback:

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

## Evidence ladder

The command name states what kind of evidence a green check supports:

| Command | Evidence |
| --- | --- |
| `npm test` | Fast deterministic regression: focused unit/integration invariants only. |
| `npm run proof:local` | Adversarial local experiments, including Git/CAS stress. |
| `npm run proof:formal` | Model checking of the formal transaction/recovery model. |
| `npm run proof:live` | Real-provider proof on GitHub-hosted runners. |

These are different evidence classes, not cumulative certification levels. A live provider proof does not replace deterministic regression or model checking, and a checked model does not prove that the implementation or provider boundary is correct.

`proof:live` dispatches `.github/workflows/disposable-agent-proof.yml` through the GitHub CLI. To target a non-default branch, pass the ref explicitly:

```sh
npm run proof:live -- --ref <branch>
```

Focused experiment and demo scripts remain available when debugging a specific claim.

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
- hostile eventually consistent readback cannot turn stale missing or old values into replayable absence; the original run remains recovery-bound until positive convergence.
- two independent obligations can remain `EXECUTING` simultaneously without losing exact claim identity;
- two fresh recovery processes can settle independent effects through one CAS authority ref;
- canonical GitHub-status effect conflicts are blocked unless graph ordering makes the sequence explicit;
- identical desired GitHub statuses on the same canonical coordinate are explicitly modeled as commuting.

The proof suite is intentionally growing; the README does not pin a historical pass count. Use the evidence ladder above to distinguish regression evidence, local adversarial evidence, formal evidence, and real-provider evidence.

## Repository shape

Paths intentionally distinguish the kind of evidence they contain:

```text
src/          reusable reference mechanism
test/         focused invariants of that mechanism
experiments/  executable empirical and adversarial proofs
formal/       machine-checked models
research/     literature, synthesis, and architectural claims
```

Current executable surfaces:

```text
src/
  git-kernel.ts              Git history / projection / claim / recovery / CAS kernel
  model.ts                   public obligation, work, run, and postcondition contract
  observation.ts             postcondition validation, authoritative readback, verification
  providers/github-status.ts GitHub commit-status provider readback

test/
  reconstruction, typed dependency identity, and focused kernel invariants

experiments/sqlite-baseline/
  original SQLite baseline implementation and proof

experiments/disposable-agent/
  worker destruction, reconstruction, and settlement

experiments/two-effect-concurrency/
  independent concurrent effects and recovery

experiments/conflicting-effect/
  provider-coordinate conflict and commutativity

experiments/eventually-consistent-readback/
  hostile negative-evidence / no-blind-replay proof

experiments/github-observation-grammar/
  OpenAPI-derived GitHub observation grammar experiment

experiments/github-object-transport/
  exact GitHub object materialization fixtures

experiments/git-stress/
  adversarial Git / CAS / clone stress coverage

formal/
  TLA+ transaction and recovery kernel with negative controls

.github/workflows/
  hosted orchestration for live proofs; implementation stays beside experiments
```

The repository layout and the command names intentionally describe the same evidence boundaries: regression tests, local experiments, formal models, and hosted provider proofs.


The experiment is intentionally small. New machinery should have to demonstrate that Git authority plus disposable local state cannot provide the required safety first.
