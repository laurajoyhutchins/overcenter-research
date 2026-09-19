# Lean semantic-kernel experiment

This experiment asks a deliberately narrow question:

> Does Overcenter's truth-deciding core become clearer and safer when its semantic decisions are executable Lean definitions with machine-checked invariants?

It does **not** rewrite Overcenter in Lean. Git transport, credentials, mutation execution, worker supervision, TLS, and provider transport remain outside this experiment.

## Current semantic slice

The Lean kernel now owns seven classes of truth decision:

1. **Obligation identity material** — verifier semantics and semantic dependency identities are explicit rather than ambient implementation detail.
2. **Settlement** — admitted observations become `done`, `ready`, or `recoveryRequired`.
3. **Realization reuse** — immutable realizations may reuse exact identity; mutable external realizations require exactly one fresh verifying observation.
4. **Kubernetes LIST/WATCH interpretation** — raw page/member evidence becomes `PRESENT`, `ABSENT`, or `INDETERMINATE`, and LIST-proved absence can be carried only through an exact-bound WATCH transcript that still ends absent.
5. **Execution replay fencing** — starting from an admitted claim, authority rotations, effect reservations, interruptions, and receipts are reduced as a pure durable-fact state machine.
6. **Claim admission** — lifecycle, dependency satisfaction, semantic-input identity, current-revision fencing, duplicate-run rejection, and capability-digest validity are derived rather than supplied as booleans.
7. **Admission graph safety** — obligation IDs must be unique, dependencies must exist, the graph must be acyclic, and incompatible GitHub status mutations must be ordered.

The semantic keys are modeled structurally. Cryptographic compression of those keys remains outside this slice.

## Claims and hostile witnesses

| Claim | Hostile case | Smallest distinguishing experiment |
| --- | --- | --- |
| Verifier semantics are material identity. | Verifier behavior changes but old realization still reuses. | Change only `verifierRevision`; key must differ. |
| `done` requires exact verification. | Wrong coordinate or uncertain read settles `done`. | Change coordinate/certainty while preserving value. |
| `ready` requires authoritative absence. | Forged negative evidence permits replay. | Change one ENOENT field; require recovery. |
| Historical `done` is not current truth for mutable external state. | External state drifts after settlement. | Reconstruct without fresh observation; reuse must be false. |
| Fresh evidence is singular and current. | Multiple fresh reads let the caller choose a convenient answer. | Supply zero, drifted, and duplicate fresh observations; mutable DONE must not satisfy dependencies. |
| Exact immutable realizations are reusable. | Producer identity poisons content-addressed reuse. | Exact immutable key reuses without worker execution. |
| Kubernetes absence requires a complete coherent LIST. | Partial page chain, wrong authority, wrong namespace, changing resourceVersion, or hidden target mints absence. | Feed each hostile transcript; classifier must be indeterminate or present, never absent. |
| Kubernetes WATCH carry requires exact continuity. | Wrong start version, broken authority, target reappears, or WATCH expires but absence is carried. | Feed hostile transcripts; require relist. |
| Execution generations are fenced. | Stale generation/authority reserves or settles. | Replay stale authority, reservation, and receipt facts; reject each. |
| Receipts bind to the exact claim. | A genuine receipt is transplanted to another revision, claim, generation, or authority. | Alter one binding coordinate; replay must reject. |
| Claimability is derived from realizations. | Caller claims downstream work while a dependency is merely historical, READY, or stale. | Remove fresh upstream verification or change semantic identity; admission must reject. |
| Claim facts bind to current authority. | A detached synthetic fact is internally self-consistent but not based on the current revision. | Make fact parent = claimed revision != current revision; Lean rejects. |
| Graph topology is authority-bearing. | Duplicate IDs, dangling dependencies, or cycles enter claimability. | Admit each hostile graph; reject before claim evaluation. |
| Conflicting provider effects require ordering. | Two unordered writes target the same GitHub repo/SHA/context with incompatible states. | Keep coordinate equal, vary desired state; reject unless an ordering path exists. |
| GitHub status contexts are case-insensitive. | `Overcenter/Proof` and `overcenter/proof` evade conflict detection. | Vary only context casing; resource identity must remain equal. |
| Identical GitHub status writes commute. | Two equivalent desired writes are unnecessarily serialized. | Same exact resource + same desired state; admission remains valid. |

The generic definitions live in `Overcenter/*.lean`. Closed adversarial fixtures use Lean's compiled decision procedure where ordinary reduction would merely spend time normalizing large finite values.

## Native JSON boundary

The compiled executable reads JSON from stdin and writes one JSON decision to stdout. It does not accept caller-provided `verified`, `complete`, `claimable`, `dependencies_done`, or `effect_conflict` booleans.

Current commands include:

- `settle`
- `kubernetes-list`
- `kubernetes-watch-carry`
- `execution-replay`
- `claim-graph`
- `claim-effect-ordering`
- `claim-admission`

Malformed JSON, unknown commands, unsupported verifier families, and malformed typed fields fail closed.

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

For Kubernetes, Lean validates per-page authority, requested namespace, continuation binding, stable snapshot `resourceVersion`, member identity fields, terminal pagination, and target membership. The caller does not provide a `complete: true` bit.

### Claim admission

The claim boundary receives:

- current authority revision;
- typed obligations and dependencies;
- historical run facts;
- fresh observations;
- the proposed claim fact.

Lean derives the current lifecycle and semantic obligation key itself. A mutable historical `DONE` does not count unless exactly one fresh observation verifies the current postcondition.

The claim candidate must bind:

```text
fact parent
    =
claimed revision
    =
current authority revision
```

before it can enter the execution reducer.

## Differential proofs

### Settlement

`differential.test.ts` compares local-file dispositions from TypeScript `projectReceipt` and the native Lean kernel for positive verification, wrong content, uncertainty, authoritative ENOENT, and tampered ENOENT certificates.

### Kubernetes provider interpretation

`kubernetes-differential.test.ts` feeds equivalent LIST transcripts to the TypeScript Kubernetes verifier and Lean's raw LIST classifier. They agree on complete absence, later-page presence, resourceVersion drift, continuation mismatch, wrong authority/namespace, interrupted pagination, and expired continuation.

`kubernetes-watch-differential.test.ts` does the same for LIST-to-WATCH absence carry.

### Execution replay

`execution-replay-differential.test.ts` feeds equivalent durable execution sequences to Lean and TypeScript `replayProjection()`. The hostile suite agrees on acceptance/rejection, final generation, authority commit, lifecycle status, and unresolved-effect state.

### Claim admission

`claim-admission-differential.test.ts` compares claim admission against TypeScript replay for:

- independent work;
- control dependencies;
- verified-content semantic dependencies;
- settlement-receipt semantic dependencies;
- stale claimed revision;
- claim-parent mismatch;
- obligation-key mismatch;
- duplicate run IDs;
- already-realized work;
- invalid capability digests;
- valid, dangling, cyclic, and duplicate-ID graph shapes.

It also deliberately records two stronger Lean boundaries:

1. TypeScript pure projection assumes the supplied `FactCommit[]` already follows authoritative Git ancestry. Lean claim admission names the current authority revision explicitly and rejects detached self-consistent claims.
2. TypeScript currently treats historical mutable `DONE` as live. Lean requires one fresh verifying observation before that realization can satisfy a dependency.

### Static effect ordering

`effect-ordering-differential.test.ts` compares Lean's derived GitHub-status effect conflicts with TypeScript admission. They agree on:

- unordered incompatible states;
- case-insensitive context aliases;
- commuting identical writes;
- different repository IDs;
- different commit SHAs;
- different contexts;
- forward dependency ordering;
- reverse dependency ordering.

## Known production semantic gap

`reuse-gap.test.ts` deliberately witnesses current TypeScript behavior:

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

Lean reuse / claim dependency
without fresh verification
  ↓
not reusable / not DONE
```

The passing test documents the present implementation. It is not the desired target. It should disappear when production mutable-realization reuse migrates to the proved semantics.

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

Complete LIST and WATCH semantics are not abstract booleans in Lean.

For LIST, the kernel derives completeness from page authority, request namespace, continuation chaining, exact snapshot `resourceVersion`, terminal pagination, member identity fields, and target membership.

For WATCH, the kernel starts from an actually absent LIST snapshot and requires exact authority/namespace, exact WATCH start `resourceVersion`, a concrete ordered event transcript, valid member identity, acceptable termination, and the target-state fold to end absent.

`resourceVersion` remains opaque. Lean does not compare it numerically; stream order plus exact start binding carry the semantic meaning.

## Execution replay

`Overcenter/Execution.lean` starts from an admitted claim and folds durable execution facts.

The reducer rejects skipped generations, stale predecessor authority, wrong-run authority changes, stale reservations, duplicate unresolved effects, judgment deferral after reservation, incorrectly bound receipts, and authority/settlement operations after terminal completion.

It preserves an unresolved effect across worker termination and clears it only on terminal observation settlement.

## Admission graph

Claim admission validates graph topology before considering a candidate:

```text
unique obligation IDs
        +
all dependencies exist
        +
acyclic graph
        +
static provider effects are safely ordered
        ↓
eligible for claim evaluation
```

GitHub status effects use a structured resource coordinate:

```text
(repository_id, commit_sha, lower(context))
```

Two writes to that resource with the same desired state commute. Different desired states require a dependency path in either direction.

## Build

```sh
cd experiments/lean-kernel
lake build
./.lake/build/bin/overcenterKernel
```

CI currently:

1. builds the Lean/native kernel;
2. replays `Overcenter.*` declarations through bundled `leanchecker`;
3. executes the native binary;
4. differential-tests local-file settlement;
5. executes the mutable-reuse gap witness;
6. adversarially tests serialized Kubernetes evidence;
7. differential-tests Kubernetes LIST interpretation;
8. adversarially tests raw Kubernetes WATCH carry;
9. differential-tests WATCH carry;
10. differential-tests execution replay/fencing;
11. differential-tests claim admission and graph topology;
12. differential-tests static GitHub effect ordering.

## Deliberate boundary

Lean does not prove GitHub, Kubernetes, Git, TLS, the operating system, or cryptographic implementations correct.

The boundary is:

> Given these authenticated provider bytes / durable facts, what conclusions may Overcenter derive?

That is intentionally much smaller than “Lean runs the orchestrator.”

## Next core slice

Claim admission still accepts `packet_identity` from the caller. That is now the sharpest pure trust boundary.

The next experiment should pass the **raw packet value** into Lean, canonicalize its semantic structure there, and make that normalized value part of the obligation key directly. Cryptographic hashing can remain a representation detail outside the proof model.

The hostile experiment is simple:

```text
same JSON meaning, different object-key order
        ↓
same semantic packet identity

material packet value changes
        ↓
different obligation identity

caller lies about packet identity
        ↓
impossible: no identity field exists to lie about
```

That would remove another externally asserted truth bit from the kernel boundary without pulling transport or cryptography into Lean.
