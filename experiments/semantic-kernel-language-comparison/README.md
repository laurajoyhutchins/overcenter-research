# Lean vs TypeScript claim-admission audition

## Question

TypeScript is the current implementation default for Overcenter's deterministic kernel. Lean has already shown that it can make settlement, realization reuse, Kubernetes evidence interpretation, and execution replay more explicit and machine-checkable.

This experiment attacks the next null hypothesis:

> Does TypeScript still deserve to own claim-admission truth, or can an executable Lean kernel provide strictly stronger safety evidence without importing graph truth from its caller?

This is not a rewrite experiment. Git transport, durable fact replay, provider adapters, hashing, credential handling, and mutation execution remain outside the audition.

## Fixed semantic slice

A claim may be admitted only when all of these are true:

1. the caller's expected project revision exactly equals current authority;
2. the target obligation exists and is currently unrealized;
3. every direct dependency is currently DONE;
4. semantic identity is fully resolved for the target;
5. no unordered incompatible effect exists for the target.

The Lean boundary may consume normalized facts such as obligation identity, dependency edges, current lifecycle states, canonical mutation resource, desired operation, and current semantic identity material.

It may **not** consume caller assertions named or equivalent to:

- `claimable`
- `dependencies_done`
- `revision_current`
- `effect_conflict_free`

Those are conclusions the kernel must derive.

## Null hypothesis

Keep claim admission in TypeScript.

Lean earns this production semantic role only if all of the following hold:

### 1. Behavioral parity

For the shared modeled contract, Lean and the current TypeScript implementation must agree on positive and hostile claim-admission cases.

A disagreement is not automatically a Lean win. It must be reduced to one of:

- a demonstrated TypeScript semantic defect;
- a demonstrated Lean semantic defect;
- an explicit contract difference that invalidates the comparison.

### 2. Generic safety proofs

Lean must machine-check general theorems equivalent to:

```text
admitted
  -> exact revision
  -> target unrealized
  -> all direct dependencies DONE
  -> semantic identity resolved
  -> no unordered incompatible effect
```

Finite examples alone do not count.

### 3. No second graph authority

Lean must derive the decision from the same normalized durable/project facts that TypeScript currently uses. It must not receive a precomputed readiness boolean or a separate persisted lifecycle/scheduler state.

### 4. Fail closed at the serialized boundary

Malformed input, unknown lifecycle values, missing referenced dependencies, duplicate obligation identity, or malformed effect facts must not produce `ADMIT`.

### 5. Operationally boring boundary

The compiled kernel must remain a narrow stdin/stdout executable boundary with no daemon, database, scheduler, provider credentials, or network dependency.

### 6. Maintenance burden must buy a stronger property

Line count does not decide the audition. A larger Lean implementation may still earn the role if the extra machinery corresponds to machine-checked invariants that TypeScript otherwise carries only as runtime branches/tests.

Conversely, if Lean merely reproduces the TypeScript decision table with more tooling and no useful generic invariant, TypeScript wins.

## Hostile cases fixed before implementation

The differential suite must include at least:

1. exact revision, no dependencies, no effect conflict -> admit;
2. stale expected revision -> reject;
3. target already EXECUTING -> reject;
4. target already DONE -> reject;
5. direct control dependency not DONE -> reject;
6. direct semantic dependency not DONE -> reject;
7. unresolved semantic identity -> reject;
8. same canonical effect resource + incompatible desired effect + no ordering -> reject;
9. same canonical effect resource + identical commuting desired effect -> admit;
10. incompatible same-resource effects with explicit dependency ordering -> admit;
11. unrelated effect resources -> admit;
12. unknown dependency -> fail closed;
13. dependency cycle -> fail closed;
14. malformed serialized lifecycle/effect input -> fail closed.

## Decision

The output of this experiment should be one of three conclusions:

- **TypeScript retains claim admission**: Lean did not buy a materially stronger property.
- **Lean earns claim admission**: executable parity plus generic proofs make the semantic boundary stronger enough to justify the toolchain.
- **Boundary is wrong**: the experiment discovers that claim admission should be decomposed differently before choosing a language.

No conclusion about the rest of Overcenter follows automatically.
