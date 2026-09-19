# Lean realization projection audition

## Question

The Lean semantic kernel now owns settlement, semantic identity, obligation-key preimage construction, claim admission, and execution replay legality.

One semantic decision remains outside that boundary:

> Given durable historical execution facts, the current semantic obligation key, and fresh authoritative provider observations, which historical realization still counts as current project truth?

The existing TypeScript `deriveLifecycles()` reconstructs historical DONE directly from a matching historical key + DONE receipt. That is correct as **historical replay**, but insufficient as **current realization projection** for mutable external state.

This experiment asks whether Lean can own the missing current-truth overlay without absorbing transport, provider I/O, hashing, or Git history mechanics.

## Architectural split fixed before implementation

Historical legality and current reality are distinct computations:

```text
durable facts
    │
    ▼
historical replay
    │
    ├── claims / generations / authority / receipts were legal
    └── historical run state
              │
              │ current semantic key
              │ fresh normalized observation
              ▼
      current realization projection
              │
              └── UNREALIZED / EXECUTING / WAITING /
                  RECOVERY_REQUIRED / DONE
```

The current projection must not rewrite historical truth.

A historical receipt may remain valid evidence that a run once settled DONE while no longer establishing that mutable external reality is DONE **now**.

## Trusted upstream inputs

This component may consume outputs of already-auditioned trusted components:

- current semantic obligation key, produced from Lean-selected key bytes plus the SHA-256 primitive;
- validated execution state for each durable run, produced by Lean execution replay;
- normalized provider observations, produced by authenticated provider adapters and structural validation.

Those are composition boundaries, not worker assertions.

## Inputs Lean may receive

For one obligation:

- normalized postcondition;
- current semantic obligation key, or unresolved;
- historical runs in durable order, each containing:
  - run id;
  - obligation key claimed by that run;
  - proof-bearing execution status from execution replay;
- optional fresh normalized observation at the exact postcondition coordinate.

Lean derives realization stability from verifier family.

## Inputs Lean must not receive

- `reusable`;
- `current`;
- `fresh_verified`;
- `fresh_authoritative_absence`;
- `stability`;
- `lifecycle`;
- `safe_to_reexecute`;
- a caller-provided settlement disposition for the fresh observation.

## Projection rules frozen before implementation

### Matching historical DONE

If the latest matching semantic realization is historically DONE:

**Immutable realization**
- no fresh observation is required;
- project DONE.

**Mutable external realization**
- no fresh observation -> RECOVERY_REQUIRED;
- fresh observation settles DONE -> DONE;
- fresh observation settles READY from authoritative absence -> UNREALIZED;
- fresh observation settles RECOVERY_REQUIRED -> RECOVERY_REQUIRED.

Therefore:

> failure to prove current reuse is not equivalent to evidence that execution is safe.

### Matching nonterminal execution

If there is no reusable matching DONE realization, the latest matching proof-bearing execution state projects:

- EXECUTING -> EXECUTING;
- WAITING -> WAITING;
- RECOVERY_REQUIRED -> RECOVERY_REQUIRED;
- READY -> UNREALIZED.

### Current key unresolved

If the current semantic key is unresolved:

- no active matching/current execution -> UNREALIZED; claim admission remains blocked by unresolved semantic identity;
- an outstanding nonterminal execution must not disappear merely because its current semantic key cannot be reconstructed -> RECOVERY_REQUIRED.

### Stale semantic key

A historical DONE realization whose key differs from the current semantic key never projects DONE.

A stale terminal realization alone projects UNREALIZED.

A nonterminal execution whose claimed key is no longer the current key must fail closed to RECOVERY_REQUIRED rather than vanish into a new executable obligation.

## Null hypothesis

Keep current realization projection in TypeScript.

Lean earns this boundary only if:

1. it derives the current lifecycle without trusted reuse/current/verification booleans;
2. generic proofs establish that mutable external DONE requires fresh verification;
3. generic proofs establish that missing/uncertain fresh evidence cannot make a previously DONE mutable realization executable again;
4. exact historical semantic-key mismatch cannot reuse a realization;
5. nonterminal stale execution cannot be erased by current-key drift;
6. the implementation composes with existing Lean settlement and execution semantics rather than re-implementing provider logic;
7. a plausible TypeScript control can express the same corrected rules, and the differential agrees on the shared hostile suite.

The experiment should be rejected if it requires provider-specific switches inside realization projection.

## Hostile cases fixed before implementation

At minimum:

1. matching immutable DONE reuses without observation;
2. matching mutable DONE + exact fresh verification -> DONE;
3. matching mutable DONE + no fresh observation -> RECOVERY_REQUIRED;
4. matching mutable DONE + uncertain fresh observation -> RECOVERY_REQUIRED;
5. matching mutable DONE + authoritative absence -> UNREALIZED;
6. matching mutable DONE + wrong-coordinate observation -> fail closed / RECOVERY_REQUIRED;
7. stale-key historical DONE -> UNREALIZED;
8. current matching EXECUTING -> EXECUTING;
9. current matching WAITING -> WAITING;
10. current matching RECOVERY_REQUIRED -> RECOVERY_REQUIRED;
11. current matching READY -> UNREALIZED;
12. stale-key nonterminal execution -> RECOVERY_REQUIRED;
13. unresolved current key + nonterminal execution -> RECOVERY_REQUIRED;
14. unresolved current key + only historical terminal runs -> UNREALIZED;
15. multiple historical matching runs select deterministically from durable order;
16. changing only producer/run identity does not invalidate an otherwise matching semantic realization;
17. external drift after historical DONE is visible in current projection;
18. deleting every materialized/cache projection and recomputing from the same durable history + same fresh observations gives the same result;
19. changing only current external reality changes current projection deliberately.

## Important expected consequence

The existing `reuse-gap.test.ts` is not merely a bug witness after this experiment. It is evidence that the runtime currently conflates historical replay with current realization truth.

A successful experiment therefore supports a future runtime split:

```text
replayProjection(commits)
       │
       └── historical authority only

projectCurrentRealizations(history, observations)
       │
       └── current truth

claim / inspect / frontier
       │
       └── consume current truth
```

Production migration is a separate step. This branch may prove the boundary without silently changing runtime behavior.

## Possible outcomes

- **Lean earns current realization projection.**
- **TypeScript retains it.**
- **Existing lifecycle vocabulary is insufficient.** If uncertainty after historical DONE cannot be represented safely without overloading execution recovery, redesign the state vocabulary before migration.
