# Lean semantic-kernel experiment

This experiment asks a deliberately narrow question:

> Does Overcenter's truth-deciding core become clearer and safer when its semantic decisions are executable Lean definitions with machine-checked invariants?

It does **not** rewrite Overcenter in Lean. Provider I/O, Git transport, credentials, mutation execution, and worker supervision remain outside this experiment.

## First semantic slice

The Lean kernel currently owns three decisions:

1. **Obligation identity material** — verifier semantics are an explicit part of identity rather than an implicit property of source code.
2. **Settlement** — an observation can produce `done`, `ready`, or `recoveryRequired`.
3. **Realization reuse** — immutable realizations may reuse exact semantic identity; mutable external realizations require a fresh verifying observation even when a historical realization was `done`.

The implementation intentionally models the **structured semantic key**, not its cryptographic compression. Hashing is a representation of identity, not the definition of identity.

## Claims and hostile witnesses

| Claim | Hostile case | Smallest distinguishing experiment |
| --- | --- | --- |
| Verifier semantics are material identity. | Change verifier behavior without changing obligation meaning. | Change only `verifierRevision`; the obligation key must differ. |
| `done` requires exact verification. | Wrong coordinate or uncertain read settles `done`. | Keep expected value equal while changing coordinate/certainty; settlement must require recovery. |
| `ready` requires accepted authoritative absence. | Forged or wrong-coordinate negative evidence permits replay. | Change only the absence certificate coordinate; settlement must require recovery. |
| Historical `done` is not current truth for mutable external state. | Provider state changes after settlement, but reconstruction still reuses the old completion. | A mutable historical realization with no fresh observation must not reuse. |
| Exact immutable realizations are reusable. | Producer identity unnecessarily poisons content-addressed reuse. | Same semantic key + immutable realization reuses without rerunning a worker. |
| Stale semantic identity never reuses. | Verifier revision or material semantic input changes but old completion survives. | Change the semantic key and require reuse to return false. |

`Overcenter/Proofs.lean` contains both generic theorems and concrete hostile examples. Compilation is therefore part proof checking and part executable regression suite.

## Build

The toolchain is pinned in `lean-toolchain`.

```sh
cd experiments/lean-kernel
lake build
./.lake/build/bin/overcenterKernel
```

CI additionally runs Lean's independent checker through `leanprover/lean-action`.

## Deliberate boundary

This first experiment does **not** trust a caller-provided `verified: true` bit. The next useful integration step is to define a narrow serialized observation boundary and differential-test the Lean decisions against the TypeScript implementation before deleting any TypeScript semantics.

It also does not claim that Lean proves GitHub, Kubernetes, Git, TLS, or the operating system correct. Those systems remain evidence sources and effect substrates. The Lean kernel answers the smaller question: given accepted facts and evidence, what conclusions may Overcenter derive?
