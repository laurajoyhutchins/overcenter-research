# Lean semantic-kernel experiment

This experiment asks a deliberately narrow question:

> Does Overcenter's truth-deciding core become clearer and safer when its semantic decisions are executable Lean definitions with machine-checked invariants?

It does **not** rewrite Overcenter in Lean. Provider I/O, Git transport, credentials, mutation execution, and worker supervision remain outside this experiment.

## Current semantic slice

The Lean kernel currently owns three decisions:

1. **Obligation identity material** — verifier semantics are an explicit part of identity rather than an implicit property of source code.
2. **Settlement** — an observation can produce `done`, `ready`, or `recoveryRequired`.
3. **Realization reuse** — stability is derived from verifier semantics. Immutable realizations may reuse exact semantic identity; mutable external realizations require a fresh verifying observation even when a historical realization was `done`.

The implementation intentionally models the **structured semantic key**, not its cryptographic compression. Hashing is a representation of identity, not the definition of identity.

## Claims and hostile witnesses

| Claim | Hostile case | Smallest distinguishing experiment |
| --- | --- | --- |
| Verifier semantics are material identity. | Change verifier behavior without changing obligation meaning. | Change only `verifierRevision`; the obligation key must differ. |
| `done` requires exact verification. | Wrong coordinate or uncertain read settles `done`. | Keep expected value equal while changing coordinate/certainty; settlement must require recovery. |
| `ready` requires accepted authoritative absence. | Forged or wrong-coordinate negative evidence permits replay. | Change one ENOENT certificate field; settlement must require recovery. |
| Historical `done` is not current truth for mutable external state. | Provider state changes after settlement, but reconstruction still reuses the old completion. | A mutable historical realization with no fresh observation must not reuse. |
| Stability is semantic policy, not historical self-assertion. | A historical record relabels mutable provider state as immutable to obtain reuse. | History contains no stability flag; the verifier family determines it. |
| Exact immutable realizations are reusable. | Producer identity unnecessarily poisons content-addressed reuse. | Same semantic key + immutable verifier family reuses without rerunning a worker. |
| Stale semantic identity never reuses. | Verifier revision or material semantic input changes but old completion survives. | Change the semantic key and require reuse to return false. |

`Overcenter/Proofs.lean` contains both generic theorems and concrete hostile examples. Compilation is therefore part proof checking and part executable regression suite.

## Native JSON boundary

The compiled kernel accepts a narrow JSON request on stdin and writes one JSON decision on stdout.

Example:

```json
{
  "command": "settle",
  "postcondition": {
    "family": "file-content",
    "verifier_revision": "file-content-equals/v1@semantics-1",
    "coordinate": "/provider/a",
    "expected": "<sha256>"
  },
  "observation": {
    "family": "file-content",
    "verifier_revision": "file-content-equals/v1@semantics-1",
    "coordinate": "/provider/a",
    "certainty": "present",
    "actual": "<sha256>",
    "absence": null
  }
}
```

Malformed JSON, unknown commands, unsupported verifier families, and malformed typed fields are rejected instead of defaulted.

The boundary does **not** accept a caller-provided `verified: true` bit.

## Differential proof

`differential.test.ts` sends the same local-file settlement cases through:

```text
TypeScript projectReceipt
          │
          ├──────── compare disposition
          │
native Lean kernel
```

The current fixtures cover:

- exact positive verification;
- wrong content;
- uncertain readback;
- authoritative direct-coordinate ENOENT;
- tampered completeness result;
- tampered provenance operation.

This lets us move semantic code across the language boundary without assuming that a successful Lean build means behavioral equivalence.

## Known semantic gap

`reuse-gap.test.ts` intentionally proves that the current TypeScript implementation and the Lean target semantics disagree about mutable historical completion:

```text
file = A
  ↓
settle DONE
  ↓
file externally changes to B
  ↓
fresh TypeScript reconstruction
  ↓
DONE          ← current behavior

Lean reuse rule with no fresh observation
  ↓
false         ← target behavior
```

The test is a **gap witness**, not an assertion that the current TypeScript behavior is desirable. It should disappear when production reuse semantics migrate to require fresh authoritative observation for mutable external realizations.

## Local-file negative evidence

Local ENOENT authority is no longer represented in Lean by an abstract `complete: true` input. The Lean kernel checks the material certificate fields directly:

- exact subject coordinate;
- exact scope coordinate;
- null snapshot;
- `direct-coordinate-read`;
- `ENOENT` result;
- `node:fs`;
- `readFileSync`;
- `ENOENT` error code.

Kubernetes absence completeness remains abstract in this slice. Its complete LIST pagination chain and WATCH-continuity semantics are the next provider-specific evidence candidate.

## Build

The toolchain is pinned in `lean-toolchain`.

```sh
cd experiments/lean-kernel
lake build
./.lake/build/bin/overcenterKernel
```

CI also:

1. replays generated `Overcenter.*` declarations through Lean's bundled `leanchecker`;
2. executes the compiled native kernel;
3. runs the TypeScript/Lean differential settlement proof;
4. runs the mutable-reuse gap witness.

## Deliberate boundary

This experiment does not claim that Lean proves GitHub, Kubernetes, Git, TLS, the operating system, or cryptographic implementations correct. Those systems remain evidence sources and effect substrates.

The semantic boundary is narrower:

> Given admitted facts and evidence, what conclusions may Overcenter derive?

The next provider-specific step is to replace the abstract Kubernetes completeness input with the actual complete-LIST / continuation / resourceVersion / WATCH evidence grammar already proved in TypeScript.
