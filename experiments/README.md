# Experiments

This directory contains bounded executable proofs. An experiment is evidence about a specific failure mode or architectural claim, not a second implementation layer.

Each experiment owns the actors, fixtures, and focused tests that change together. GitHub requires workflow YAML under `.github/workflows/`, so hosted workflow files remain there but should stay thin and invoke the corresponding experiment.

## Experiment index

- `assignment-capsule/` - exact Overcenter claim plus self-contained task-byte delivery to a no-checkout worker and trusted settlement.
- `sqlite-baseline/` - original SQLite-backed baseline.
- `disposable-agent/` - worker destruction, reconstruction, authoritative readback, and settlement.
- `two-effect-concurrency/` - independent concurrent effects and recovery through one authority ref.
- `conflicting-effect/` - provider-coordinate conflict, ordering, and commutativity.
- `eventually-consistent-readback/` - hostile stale or negative provider readback and the no-blind-replay rule.
- `current-realization-admissibility/` - fresh authoritative observation over historical DONE, including withdrawal, indeterminate blocking, and cache-free reconstruction.
- `github-observation-grammar/` - generated GitHub observation vocabulary and live ref proof.
- `kubernetes-observation/` - second-provider structural certificate, UID/resourceVersion identity, complete LIST, WATCH continuity, and reconstruction proof.
- `linkml-ontology/` - structural ontology audition: one LinkML model projected to JSON Schema, TypeScript, and SHACL with an explicit semantic-boundary negative control.
- `linkml-contract-refactor/` - production-facing maintenance experiment over the real SettlementObservation structural contract.
- `lisp-semantics/` - semantic-coherence control: hand-wired TypeScript versus one Lisp-shaped verifier definition compiled to canonical IR.
- `github-object-transport/` - exact GitHub object transport fixtures.
- `git-stress/` - adversarial Git, CAS, clone, GC, and contention coverage.
- `storage-backend-comparison/` - append-only Git versus SQLite authority performance, replay, CAS, and crash-prefix comparison.
- `datalog-projection/` - declarative project-status projection from validated durable history plus recomputed semantic judgments.
- `projection-comparison/` - mutable lifecycle versus TypeScript, status-free SQL, and Datalog over one normalized projection contract.
- `bounded-graph-exhaustion/` - exhaustive small-model coverage for DAG topology, lifecycle projection, and control-versus-semantic invalidation.
- `production-criticality-ranking/` - revision-bound quantitative ranking of production callables, calibrated against prior human judgments.

## Experiment contract

Maintained experiments are registered in [`registry.json`](./registry.json). The registry is the machine-readable acceptance contract for explainability and reproducibility: question, bounded claim, plausible contrast, reproduction command, material environment, success criteria, exact evidence identity, interpretation, and non-claims must be explicit.

```sh
npm run experiments:list
npm run experiment -- <experiment-id>
npm run experiments:deterministic
npm run test:experiment-contract
```

CI runs the contract validator through `npm test`. Every directory under `experiments/` must be registered. Shared plumbing is permitted only when explicitly classified as `kind: support`; `provider-observation/` is the current example.

A hosted workflow is an integration harness, not the only explanation of an experiment. Hosted claims still require an experiment-local README and a deterministic contract surface wherever one exists.

Reusable mechanism belongs in `src/`. Reusable test plumbing belongs in `test/support/`. Focused mechanism invariants belong in `test/`. Machine-checked models belong in `formal/`. Literature and synthesis belong in `research/`.

## Proof lineage

The repository began with two storage experiments:

```text
experiments/sqlite-baseline/kernel.js
        ↓
prove the smallest local state machine

src/git-kernel.ts
        ↓
ask whether durable shared authority can collapse to
immutable Git objects + one authority ref + CAS
```

That progression is historical evidence, not the conceptual entry point for Overcenter. The current architecture is described in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

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
npm run proof:local                  # adversarial local experiments
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
