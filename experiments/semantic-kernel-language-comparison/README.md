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


## Result

**Lean earns the bounded claim-admission decision role.**

Final evaluated head before this result note:

`72560b8e062b212b58cdbcb5b5a8c075e8b0448b`

Exact-head evidence:

- Lean vs TypeScript claim admission, PR run `35424430244`: **PASS**
- Lean semantic kernel proof, run `35424430234`: **PASS**
- repository Evidence workflow, run `35424430237`: **PASS**
- independent branch push audition, run `35424428123`: **PASS**

The result satisfies the precommitted admission rule:

1. **Behavioral parity:** every frozen positive and hostile case agrees with the current TypeScript control.
2. **Generic safety proofs:** Lean proves that any admitted claim implies well-formed context, exact revision, unrealized target, DONE direct dependencies, resolved semantic inputs, and absence of an unordered incompatible effect.
3. **No second graph authority:** the kernel receives normalized obligation/dependency/lifecycle/effect facts and derives admission; it receives no readiness or conflict-free assertion.
4. **Fail closed boundary:** malformed lifecycle values and unsupported commands are rejected rather than admitted.
5. **Operationally narrow:** the challenger is a stdin/stdout executable with no persistence, provider credentials, network access, scheduler, or daemon state.
6. **Stronger property:** TypeScript and Lean implement the same tested decision for this slice, but Lean additionally establishes universal implications for every value accepted by `claimAdmissible`.

### What the audition did not show

Lean did **not** discover a new TypeScript claim-admission bug in the frozen cases. The TypeScript control behaved correctly throughout.

The earned boundary is therefore deliberately narrower than “Lean owns all admission semantics”:

```text
TypeScript / provider-specific deterministic software
  normalize authenticated durable facts
  derive canonical provider mutation semantics
  derive semantic dependency identity material
                     |
                     v
             Lean admission kernel
  graph well-formedness
  exact revision
  target lifecycle
  dependency satisfaction
  semantic-input availability
  effect ordering
                     |
                     v
                ADMIT / REJECT
```

Canonical hashing, provider semantics, authenticated fact acquisition, and durable claim commit remain outside this experiment.

### Interpretation

The null hypothesis survives for ordinary Overcenter software but loses for this bounded truth-deciding slice.

There is no evidence here for rewriting the integration plane in Lean. There **is** evidence for moving admission predicates whose correctness can be stated as invariants behind an executable proof-bearing kernel, provided the normalization boundary remains small and differential tests continue to bind Lean behavior to production semantics.

The next useful falsifier is not a larger rewrite. It is to reduce the amount of semantic preprocessing the TypeScript side performs and see whether Lean can own the next derivation without becoming a duplicate provider adapter.

## Current-head confirmation

Exact evaluated revision `d63d65eea923ceac2902488c47eab29111344dd6` passed claim-admission audition `35424504409`, Lean kernel `35424504483`, and repository Evidence `35424504511`. This revision is the reproducible evidence identity for the current stacked result.
