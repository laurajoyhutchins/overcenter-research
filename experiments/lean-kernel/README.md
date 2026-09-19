# Lean semantic-kernel experiment

This experiment asks a deliberately narrow question:

> Does Overcenter's truth-deciding core become clearer and safer when its semantic decisions are executable Lean definitions with machine-checked invariants?

It does **not** rewrite Overcenter in Lean. Git transport, credentials, mutation execution, worker supervision, TLS, and provider transport remain outside this experiment.

## Current semantic slice

The Lean kernel now owns four decisions:

1. **Obligation identity material** — verifier semantics are explicit identity.
2. **Settlement** — admitted observations become `done`, `ready`, or `recoveryRequired`.
3. **Realization reuse** — immutable realizations may reuse exact identity; mutable external realizations require fresh verification.
4. **Kubernetes LIST interpretation** — raw page/member evidence becomes `PRESENT`, `ABSENT`, or `INDETERMINATE`.

The structured semantic key is modeled directly. Cryptographic compression of that key is deliberately outside this slice.

## Claims and hostile witnesses

| Claim | Hostile case | Smallest distinguishing experiment |
| --- | --- | --- |
| Verifier semantics are material identity. | Verifier behavior changes but old realization still reuses. | Change only `verifierRevision`; key must differ. |
| `done` requires exact verification. | Wrong coordinate or uncertain read settles `done`. | Change coordinate/certainty while preserving value. |
| `ready` requires authoritative absence. | Forged negative evidence permits replay. | Change one ENOENT field; require recovery. |
| Historical `done` is not current truth for mutable external state. | External state drifts after settlement. | Reconstruct without fresh observation; reuse must be false. |
| Stability is semantic policy. | History relabels mutable state immutable. | History contains no stability flag. |
| Exact immutable realizations are reusable. | Producer identity poisons content-addressed reuse. | Exact immutable key reuses without worker execution. |
| Kubernetes absence requires a complete coherent LIST. | Partial page chain, wrong authority, wrong namespace, changing resourceVersion, or hidden target mints absence. | Feed each hostile transcript; classifier must be indeterminate or present, never absent. |

`Overcenter/Proofs.lean` contains generic theorems plus concrete hostile examples.

## Native JSON boundary

The compiled executable reads JSON from stdin and writes one JSON decision to stdout.

### Settlement

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

### Raw Kubernetes LIST

```json
{
  "command": "kubernetes-list",
  "coordinate": {
    "authority_id": "kind:test-cluster",
    "namespace": "proof",
    "name": "target"
  },
  "snapshot_resource_version": "500",
  "pages": [
    {
      "authority_id": "kind:test-cluster",
      "request_namespace": "proof",
      "request_continue": null,
      "response_continue": "",
      "snapshot_resource_version": "500",
      "members": []
    }
  ]
}
```

For Kubernetes, Lean validates per-page authority, requested namespace, continuation binding, stable snapshot `resourceVersion`, member identity fields, terminal pagination, and target membership. The caller does not get to provide a `complete: true` or `verified: true` bit.

Malformed JSON, unknown commands, unsupported verifier families, and malformed typed fields fail closed.

## Differential proofs

### Settlement

`differential.test.ts` compares local-file dispositions from `projectReceipt` and the native Lean kernel for positive verification, wrong content, uncertainty, authoritative ENOENT, and tampered ENOENT certificates.

### Kubernetes provider interpretation

`kubernetes-differential.test.ts` feeds equivalent LIST transcripts to the existing TypeScript Kubernetes verifier and Lean's raw LIST classifier. They currently agree on:

- complete absence;
- target present on a later page;
- `resourceVersion` drift;
- broken continuation binding;
- wrong page authority;
- wrong requested namespace;
- wrong-namespace member;
- interrupted pagination;
- expired continuation.

This is the first point in the experiment where Lean independently interprets provider evidence rather than merely consuming a provider certificate minted by TypeScript.

## Known semantic gap

`reuse-gap.test.ts` deliberately witnesses one current disagreement:

```text
file = A
  ↓
settle DONE
  ↓
external drift → file = B
  ↓
fresh TypeScript reconstruction
  ↓
DONE

Lean reuse with no fresh observation
  ↓
false
```

The passing test documents current TypeScript behavior. It is not the desired target. It should disappear when production mutable-realization reuse is migrated.

## Local-file negative evidence

Lean validates the material direct-coordinate ENOENT certificate fields itself:

- exact subject coordinate;
- exact scope coordinate;
- null snapshot;
- `direct-coordinate-read`;
- `ENOENT` result;
- `node:fs`;
- `readFileSync`;
- `ENOENT` error code.

## Kubernetes boundary

Complete LIST semantics are no longer abstract in Lean.

The remaining Kubernetes temporal question is **WATCH continuity**. A future slice should determine exactly what transport evidence is sufficient to carry an absence fact from LIST snapshot resourceVersion `R` through a WATCH without smuggling a `continuity: maintained` assertion across the boundary.

## Build

```sh
cd experiments/lean-kernel
lake build
./.lake/build/bin/overcenterKernel
```

CI:

1. builds the Lean/native kernel;
2. replays `Overcenter.*` declarations through bundled `leanchecker`;
3. executes the native binary;
4. differential-tests local-file settlement;
5. executes the mutable-reuse gap witness;
6. adversarially tests serialized Kubernetes evidence;
7. differential-tests Kubernetes provider interpretation against TypeScript.

## Deliberate boundary

Lean does not prove GitHub, Kubernetes, Git, TLS, the operating system, or cryptographic implementations correct.

The boundary is:

> Given these authenticated provider bytes / durable facts, what conclusions may Overcenter derive?

That is intentionally much smaller than “Lean runs the orchestrator.”
