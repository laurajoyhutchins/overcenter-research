# Experiments

This directory contains bounded executable proofs. An experiment is evidence about a specific failure mode or architectural claim, not a second implementation layer.

Each experiment owns the actors, fixtures, and focused tests that change together. GitHub requires workflow YAML under `.github/workflows/`, so hosted workflow files remain there but should stay thin and invoke the corresponding experiment.

## Experiment index

- `execution-witness/` - historical bounded syscall-witness result: pre-send non-occurrence evidence safely discharged 2/4 interrupted cases with zero false certainty.
- `witness-minimization/` - historical minimization result: post-hoc witness reduction is strong, but historical minima alone cannot define a future complete capture contract.
- `git-metadata-independence/` - historical proof that deterministic regression/experiment evidence does not require ambient checkout identity.
- `tree-bound-candidate-evidence/` - historical classification experiment for tree/toolchain-bound expensive candidate proofs.
- `tree-evidence-derivation/` - historical derivation-contract proof for applying revision-free tree evidence across identical-content merges.
- `merge-evidence-substitution/` - historical negative result: identical tree/merge relation alone cannot substitute source-SHA-bound evidence.
- `recovery-reasoning/` - historical deterministic recovery frontier: 5/5 mechanically recoverable cases resolved with zero false certainty; judgment only after enumerable safe search is exhausted.
- `recovery-agent-search/` - historical negative one-shot inference result: 3/7 versus the deterministic 4/7 baseline, with zero false certainty.
- `recovery-agent-refinement/` - historical bounded-refinement result: 3/7 → 4/7 cumulative, tying rather than beating the deterministic baseline.
- `assignment-capsule/` - exact Overcenter claim plus self-contained task-byte delivery to a no-checkout worker and trusted settlement.
- `transport-not-dispatched-evidence/` - preregistered HTTPS transport experiment for trustworthy pre-dispatch evidence on fresh sockets.
- `adapter-uncertainty-exploration/` - bounded production-adapter uncertainty exploration for retry-relevant durable-state collisions.
- `adapter-diagnosability/` - finite-state diagnosability and safe-diagnosability analysis for mutation ambiguity.
- `github-status-not-dispatched-release/` - production-path treatment for exact reservation release from trusted pre-dispatch transport evidence.
- `attempt-unification/` - falsifies the single recovery-clock simplification and proves authority fencing and unresolved mutation identity require distinct temporal dimensions.
- `codex-closed-loop/` - bounded reasoning-worker transaction with trusted claim, verification, settlement, publication, and readback kept outside the worker.
- `disposable-agent/` - worker destruction, reconstruction, authoritative readback, and settlement.
- `distributed-authority-handoff/` - Postgres-free multi-controller authority handoff through immutable Git facts plus one remote exact-head CAS coordinate.
- `distributed-authority-chaos/` - repeated multi-controller CAS contention, crash injection, authority rotation, and bounded fresh-controller recovery.
- `authority-storage-decomposition/` - separate immutable fact objects from the exact-head authority CAS and test semantic/backend equivalence.
- `ambient-authority-boundary/` - separates substrate-owned provider capability from Overcenter project-truth authority.
- `two-effect-concurrency/` - independent concurrent effects and recovery through one authority ref.
- `conflicting-effect/` - provider-coordinate conflict, ordering, and commutativity.
- `eventually-consistent-readback/` - hostile stale or negative provider readback and the no-blind-replay rule.
- `current-realization-admissibility/` - fresh authoritative observation over historical DONE, including withdrawal, indeterminate blocking, and cache-free reconstruction.
- `github-observation-grammar/` - generated GitHub observation vocabulary and live ref proof.
- `kubernetes-observation/` - second-provider structural certificate, UID/resourceVersion identity, complete LIST, WATCH continuity, and reconstruction proof.
- `kubernetes-configmap-effect/` - second-provider mutation falsifier covering reservation, PATCH uncertainty, UID recreation, resourceVersion races, WATCH continuity, and no-blind-retry.
- `lean-semantic-oracle/` - historical exact-revision TypeScript-vs-Lean differential; executable proof retained at its evaluated revision.
- `lisp-semantics/` - semantic-coherence control: hand-wired TypeScript versus one Lisp-shaped verifier definition compiled to canonical IR.
- `github-object-transport/` - exact GitHub object transport fixtures.
- `generated-effect-protocol/` - historical positive generator/checker result for mechanical effect protocol facts.
- `generated-effect-production-differential/` - historical negative adoption result: behavior matched, but first-adoption surface cost was 5.314x handwritten.
- `git-stress/` - adversarial Git, CAS, clone, GC, and contention coverage.
- `storage-backend-comparison/` - append-only Git versus SQLite authority performance, replay, CAS, and crash-prefix comparison.
- `substrate-capability-admission/` - authenticated, context-bound capability admission with non-authorizing point absence and hostile evidence controls.
- `source-obligation-integration/` - stable source intent, claim-time Git fencing, trusted current-main verification, CAS integration, conflict rejection, and replay detection.
- `research-result-obligation-integration/` - historical bounded experiment showing promotion semantics under a synthetic trusted evaluator; it did not establish a production evidence-authentication boundary.
- `verified-generated-output/` - preregistered test of evidence-backed generated artifact identity and downstream settlement-receipt semantics.
- `scheduler-bottleneck/` - decompose history scan, semantic replay, READY-read, and bare SQLite authority-CAS costs.
- `core-loop-concurrency/` - exact production-path bounded effect-concurrency benchmark behind one authority lane.
- `scheduler-liveness/` - test conditional scheduler liveness with TLC plus an executable hostile scheduler, including fixed-set recovery fairness and continual fresh-work admission.
- `scheduler-policy-comparison/` - compare fresh-first, recovered-first, class alternation, and replay-derived service age under hostile open-system scheduling.
- `datalog-projection/` - declarative project-status projection from validated durable history plus recomputed semantic judgments.
- `projection-comparison/` - mutable lifecycle versus TypeScript, status-free SQL, and Datalog over one normalized projection contract.
- `bounded-graph-exhaustion/` - exhaustive small-model coverage for DAG topology, lifecycle projection, and control-versus-semantic invalidation.
- `frontier-prioritization/` - exhaustive and sampled proof that apparently ambiguous READY-frontier priority can be resolved or verified deterministically before AI escalation.
- `production-criticality-ranking/` - revision-bound quantitative ranking of production callables, calibrated against prior human judgments.
- `production-latency/` - SQLite-to-GitHub successful-transaction latency decomposition: local authority/reservation/settlement versus provider I/O.
- `typed-capability-authority/` - preregistered Rust differential for sealed affine effect authority, compile-fail invalid states, and sequential/concurrent admission cost.
- `authority-flow-analysis/` - static abstract interpretation of untrusted data, revision, lease, and mutation authority across serialization, queues, joins, aliases, and dynamic dispatch.
- `effect-authority-decay/` - current-main production broker experiment testing whether bound authority eliminates downstream raw-coordinate reconstruction while preserving the final runtime fence.
- `rust-exec-typestate-boundary/` - historical negative: typestate preserved the real Rust confinement proof but removed no runtime guard class and increased source complexity.

## Experiment integrity

Experiments use ordinary repository machinery rather than a parallel experiment authority.

```text
Git commit             freezes the design
ordinary test/benchmark executes the treatment and scorer
GitHub Actions run      binds hosted evidence to an exact revision
artifacts + digests     preserve raw observations when needed
Overcenter              may consume that evidence only through a separately implemented trusted boundary
```

`experiments/registry.json` is an archival catalog and explainability aid. It is not project truth, a preregistration authority, an experiment runner, or a merge-gate input. Historical entries retain evaluated revisions and reproduction notes because older experiments already cite the catalog.

A claim is preregistered only when repository history demonstrates that the material design existed before the first outcome-bearing execution. The frozen design includes the question, contrast or falsifier, treatment corpus, acceptance thresholds, and scorer when those are material. Changing those after observing an outcome creates calibration or a new experiment; prose cannot retroactively make the earlier run confirmatory.

Scientific outcomes and infrastructure outcomes remain separate. A falsified hypothesis is a valid scientific result. Broken fixtures, failed execution, missing evidence, or a scorer that cannot run are execution failures.

Maintained correctness properties belong in ordinary `test/`, `src/`, or `formal/` machinery after promotion. Experiment directories preserve bounded treatments and explanations; they are not a second regression framework. Hosted workflows stay thin and run the experiment they exist to exercise.

Source promotion now has one narrow production admission primitive in `src/source/github-evidence-admission.ts`. One exact Git commit freezes the promotion task and the experiment machinery that may authorize it. Admission reads the existing `SourceTaskPacket` from that commit and accepts it only when canonical GitHub Actions observations show:

- the named workflow ran successfully on that exact same commit;
- the exact workflow job belongs to that run and attempt;
- that job completed successfully; and
- its name is `promote:<task-path>`, binding the provider result to the frozen task without a parallel result manifest.

Changing the task, treatment, scorer, or workflow produces a new Git identity and therefore cannot reuse evidence from the prior design. A falsified experiment can remain a successful workflow while its promotion job is skipped. Registry text and caller-declared outcome strings have no authority. This primitive admits the frozen source task; live source-candidate execution and integration remain separate machinery.

## Statistical evidence

Statistical machinery is claim-specific rather than experiment-wide. One experiment may contain an
exhaustive safety differential and a sampled performance claim, and those claims require different
evidence.

The registry uses four evidence classes:

- `exhaustive`: every state in the declared bounded model is enumerated; report the bound and
  coverage rather than a sampling interval.
- `deterministic-corpus`: every case in a fixed corpus is evaluated; conclusions remain bounded to
  that corpus unless separate generalization evidence exists.
- `performance`: timing, throughput, or resource measurements vary across runs and require an
  explicit sampling and uncertainty plan for confirmatory claims.
- `stochastic`: model or randomized behavior varies across invocations and requires explicit
  sampling and uncertainty machinery before making population/generalization claims.

A `performance` or `stochastic` registry analysis must declare its estimand, sampling unit,
planned or actual sample count, uncertainty method, and stopping rule. A confirmatory claim must also
declare a decision rule and may not use `uncertainty.method = "none"`.

`npm run check:experiment-statistics` enforces that contract for the statistical experiment claims
currently under the ratchet. Shared helpers in `scripts/experiment-statistics.ts` provide paired
ratios, deterministic percentile-bootstrap intervals, and the one-sided exact upper bound for zero
observed failures.

## Proof lineage

The original standalone SQLite baseline is retained as a historical registry record at its evaluated revision rather than as executable scaffolding on `main`. The current architecture is described in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

### Disposable worker handoff

The first disposable-agent proof established this lifecycle:

```text
central Git authority
        ↓
Agent A claims exact run
        ↓
Agent A performs external effect
        ↓
Agent A repo/cache/DB/process disappear
        ↓
supervisor records exact run termination
        ↓
fresh Agent B reconstructs unresolved run
        ↓
Agent B observes external truth independently
        ↓
same run settles from authoritative readback
```

No Agent A local state is required by Agent B.

A hosted GitHub Actions proof then exercised the handoff across two different hosted runners. Workflow run `35303766455` left the original claim, recovery, effect identity, and settlement in Git/GitHub authority rather than passing worker-local state between jobs.

Historical coordinates from that run:

```text
workflow run:        35303766455
claim:               d9f2c9a20b37c2da757c0988678d61768c05e70a
recovery:            175dbfec7219dbe9c33904b49f609d79b11add25
settlement/authority: ae574663ed1ec321ae1121a48fe92019c5eed006
run:                 bc85b322-4fa7-4fb1-a8da-3f72f1b13803
```

### Hardened trust-boundary proof

The first hardened hosted proof separated definition/claim authority from recovery/settlement authority, but still gave Agent A repository-scoped `statuses: write`. That proved the worker could not redefine project authority or settlement truth, not that it lacked provider mutation authority.

The current workflow tightens that boundary using only GitHub Actions job permissions:

```text
trusted project authority
  define immutable obligation
  claim exact snapshot
            ↓
authority-untrusted Agent A
  contents: read
  no statuses: write
  no ExecutionPermit
  corrupt local checkout/config/cache/source
  direct provider mutation attempt must fail
  emit no provider authority
  terminate
            ↓
trusted effect broker
  contents: write
  statuses: write
  require explicit immutable effect contract
  derive provider coordinates from authoritative postcondition
  acquire fresh execution generation
  reserve effect
  perform exact provider mutation
  terminate before settlement
            ↓
trusted recovery
  acquire another fresh execution generation
  reconstruct unresolved reservation from Git
  read canonical GitHub provider state
  settle through exact CAS
```

This revised hosted proof passed as workflow run `35389453056` at exact source revision `f8a883d6214d76b0b609eb05e3798d6238d108cc`.

Observed proof coordinates:

```text
workflow run:         35389453056
source revision:      f8a883d6214d76b0b609eb05e3798d6238d108cc
run:                  0688f8aa-b96f-41df-9866-f8041226672e
claim:                cfbb9f334f214d7b9268448c0d424c40e8b2460c
worker authority write: HTTP 403
worker provider write:  HTTP 403
broker generation:    2
recovery generation:  3
recovery:             3a2bd35b0ac2b19d725621d1c6aeb4c547a86195
settlement/authority: 7bd05e5f4bf9cc2f5f8460e32ce902e1fe77b364
provider state:       success
final disposition:    DONE
```

Workflow run `35304838786` demonstrated that local executor tampering does not redefine the obligation, authority ref, verifier, canonical repository identity, exact input SHA, or settlement decision.

Historical coordinates:

```text
workflow run:         35304838786
workflow head:        b0add388e13933de643d1ecbe7a9f0ac47200e43
run:                  03fd76fa-9213-4b30-9411-8b34a5da68ea
claim:                349c2eebcb079378a22bbd16bbf54ee25d1f2391
recovery:             0b4070019b46252ccdbefa78fce7b32bea0f8833
settlement/authority: 61a763dbe43af85f90bbfb1356427f3050b29ce1
repository_id:        1354872053
provider context:     overcenter/trust-proof/35304838786/1
provider state:       success
```

That historical proof deliberately placed the target GitHub status behind 100 newer distractor statuses so canonical readback had to cross the first status page before settlement.

Its capability claim was intentionally limited. GitHub grants `statuses: write` at repository scope, not at one SHA/context coordinate. The experiment proves that the executor cannot redefine Overcenter authority or certify its own settlement; it does not prove least-privilege provider mutation capability.

### Reconstructible project projection

The Git authority experiment later removed privileged lifecycle state entirely.

Current obligation definitions, claims, and receipts are replayed to derive the project projection. A destructive proof repeatedly:

```text
derives projection
      ↓
materializes a cache
      ↓
deletes the cache
      ↓
creates a fresh clone
      ↓
replays authority history
      ↓
asserts byte-identical projection + digest
```

The adversarial dependency suite exercises control versus semantic dependencies, exact obligation keys, amendment ancestry, historical realization reuse, and invalidation only when selected semantic identity actually changes.

### Hostile provider readback

`eventually-consistent-readback/` models a provider where a successful write may precede convergence of the read model.

Missing or stale non-matching reads remain `uncertain`. They do not become authoritative evidence of absence and therefore cannot release replayable work. Only provider evidence that is strong enough for the adapter contract can settle or make retry safe.

### Concurrency and effect conflict

`two-effect-concurrency/` demonstrates that external effects need not be globally serialized merely because project authority commits through one CAS coordinate.

`conflicting-effect/` then adds adapter-specific conflict semantics for GitHub commit statuses:

```text
repository identity
+ exact commit
+ normalized status context
```

Identical desired states may commute. Incompatible desired states must be graph-ordered; otherwise they remain blocked rather than racing.

## Running experiments

The evidence classes are deliberately separate:

```sh
npm test                              # fast deterministic regression only
npm run test:kubernetes-observation # focused deterministic Kubernetes semantics
npm run test:lisp-semantics          # focused semantic-coherence experiment
npm run test:datalog                # Soufflé projection differential
npm run test:current-realization-admissibility # current DONE reuse against fresh authority
npm run test:bounded-graph          # exhaustive bounded graph/state model
npm run test:storage-backend-safety  # CAS + SIGKILL committed-prefix invariants
npm run bench:storage-backends       # host-dependent Git vs SQLite performance
```

Focused commands are listed in [`../README.md`](../README.md) and `package.json`.

Hosted proofs live under [`../.github/workflows/`](../.github/workflows/). Their job is to exercise the corresponding experiments against real provider authority, not to carry a second copy of the architecture. The Kubernetes proof is invoked explicitly by `kubernetes-observation-semantics.yml`; it is not implied by `npm test`.
