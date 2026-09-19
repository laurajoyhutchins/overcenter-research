# Experiments

This directory contains bounded executable evidence for Overcenter's architectural claims.

An experiment is not a second product implementation. It exists to answer a specific question, expose a hostile case, or compare plausible alternatives. Reusable mechanism moves to `src/` only after the experiment has earned that promotion.

## How to read an experiment

A useful experiment should make five things easy to find:

1. **Question** - what uncertainty is being tested?
2. **Competing hypothesis** - what plausible alternative could be better?
3. **Hostile case** - what would falsify the desired claim?
4. **Observed result** - what actually happened?
5. **Boundary** - what the result does *not* justify.

The repository deliberately keeps negative results. A falsified abstraction is useful evidence.

## Stable experiment areas

| Area | What it tests |
| --- | --- |
| `sqlite-baseline/` | the original minimal local transaction/recovery state machine |
| `disposable-agent/` | worker destruction, reconstruction, authoritative readback, and settlement |
| `two-effect-concurrency/` | independent external effects and concurrent recovery through one authority coordinate |
| `conflicting-effect/` | provider-coordinate conflict, ordering, and commutativity |
| `eventually-consistent-readback/` | hostile stale/negative provider reads and the no-blind-replay rule |
| `current-realization-admissibility/` | whether historical realizations still satisfy current authority |
| `github-observation-grammar/` | generated GitHub observation vocabulary and exact-object readback |
| `provider-observation/` | provider-neutral provenance and structural-certificate machinery |
| `kubernetes-observation/` | Kubernetes identity, complete LIST snapshots, authoritative absence, and WATCH continuity |
| `github-object-transport/` | exact GitHub object transport fixtures |
| `git-stress/` | Git/CAS contention, clone/reconstruction, and adversarial storage behavior |
| `storage-backend-bakeoff/` | Git versus SQLite authority performance, CAS, replay, and crash-prefix behavior |
| `datalog-projection/` | declarative project-state projection as a differential oracle |
| `lisp-semantics/` | semantic-coherence comparison between hand-wired implementation and canonical semantic IR |
| `bounded-graph-exhaustion/` | exhaustive small-model graph topology and lifecycle semantics |

Other language and formal-tool experiments are intentionally non-authoritative unless separately promoted. Their job is to sharpen or falsify claims, not to collect runtimes.

## What graduated into the supported path

Experiments have already changed the implementation in concrete ways.

### SQLite authority

The storage bakeoff showed that repeatedly using Git as the hot durable transaction path was unnecessarily expensive once the core semantics had become storage-neutral. SQLite now owns the supported authority path, while Git remains an independent reference/replay backend.

That promotion did **not** move project semantics into SQLite. The shared durable-fact contract and backend differential tests remain the guardrail.

### Go physical computation

The Go experiments justified one narrow role: physical execution of already-authorized pure computation.

The admitted boundary is:

```text
TypeScript authority
      |
exact authorized computation
      |
Go executor
      |
attempt evidence
      |
TypeScript observation + settlement
```

Go does not own graph truth, provider interpretation, external mutation, or settlement.

The production profile subsequently red-teamed this boundary for forged success, namespace escape, network side effects, mutable source identity, effect/computation laundering, stale generation recovery, and catastrophic executor death. The supported slice converts those failures into fail-closed regressions.

### Proof and differential oracles

Lean, Datalog, F*, bounded exploration, and related formal/declarative experiments remain useful precisely because they are independent of the runtime implementation. They should not gain production authority merely because they prove or reproduce a property well.

## Evidence classes

Use the root commands unless you are debugging a specific experiment:

```sh
npm test
npm run proof:local
npm run proof:formal
npm run proof:production
npm run proof:live
```

Focused commands include:

```sh
npm run test:projection
npm run test:dependency-edges
npm run test:handoff
npm run test:eventual
npm run test:concurrency
npm run test:effect-order
npm run test:github-observation
npm run test:kubernetes-observation
npm run test:provider-observation
npm run test:current-realization-admissibility
npm run test:datalog
npm run test:lisp-semantics
npm run test:bounded-graph
npm run test:storage-backend-safety
npm run bench:storage-backends
npm run test:stress
```

A benchmark result is not automatically a safety result. A formal result is not automatically an implementation result. A hosted result is not automatically a provider-general result. The command and experiment should make the supported claim explicit.

## Where code belongs

```text
src/          reusable authoritative mechanism
test/         focused mechanism invariants
test/support/ reusable test plumbing
experiments/  bounded empirical/adversarial evidence
formal/       machine-checked models
research/     prior art, claim taxonomy, synthesis
```

When an experiment succeeds, the default next question is not "how do we keep this implementation?" It is:

> What is the smallest durable mechanism justified by the evidence?

That keeps the research tree useful as an independent witness instead of letting it quietly become a second production architecture.

For the current architecture, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For the public overview and evidence ladder, return to [`../README.md`](../README.md).
