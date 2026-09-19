# Lean realization projection audition

## Integration falsification and correction

Runtime integration on PR #92 falsified one part of the initial experiment result.

A fresh observation can prove that the postcondition is true **now**, but it cannot by itself prove that the observed state realizes the current semantic-input key. The hostile semantic-dependency suite demonstrated the failure:

```text
realization under key K is DONE
semantic dependency changes
K -> K'
output bytes happen to remain unchanged
fresh observation verifies the output
```

Treating that observation as a new producer-independent DONE would silently launder the stale realization into `K'`, defeating semantic dependency invalidation.

The corrected generic rule is therefore:

```text
matching key-bound realization + required fresh verification
        -> may project DONE

no matching key-bound realization + bare ambient observation
        -> UNREALIZED
```

Producer-independent realization reuse still belongs in the architecture, but it requires explicit realization provenance bound to the exact obligation key, such as a future realization certificate. Ambient state alone is not that certificate.

This correction was made in the Lean definition and differential rather than weakening the adversarial dependency tests.

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

### Bare fresh observations are not realization provenance

A fresh observation can revalidate a realization already bound to the current obligation key.

It cannot create a new realization for that key by itself.

This distinction is necessary because the obligation key contains semantic inputs that may not be observable from the postcondition alone. A future producer-independent realization surface therefore needs an explicit exact-key realization certificate rather than inference from ambient provider state.

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

1. never-realized obligation + exact bare fresh verification -> UNREALIZED;
2. stale-key historical DONE + unchanged freshly verified output -> UNREALIZED;
3. matching immutable DONE reuses without observation;
4. matching mutable DONE + exact fresh verification -> DONE;
5. matching mutable DONE + no fresh observation -> RECOVERY_REQUIRED;
6. matching mutable DONE + uncertain fresh observation -> RECOVERY_REQUIRED;
7. matching mutable DONE + authoritative absence -> UNREALIZED;
8. matching mutable DONE + wrong-coordinate observation -> fail closed / RECOVERY_REQUIRED;
9. stale-key historical DONE -> UNREALIZED;
10. current matching EXECUTING -> EXECUTING;
11. current matching WAITING -> WAITING;
12. current matching RECOVERY_REQUIRED -> RECOVERY_REQUIRED;
13. current matching READY -> UNREALIZED;
14. stale-key nonterminal execution -> RECOVERY_REQUIRED;
15. unresolved current key + nonterminal execution -> RECOVERY_REQUIRED;
16. unresolved current key + only historical terminal runs -> UNREALIZED;
17. multiple historical matching runs select deterministically from durable order;
18. external drift after historical DONE is visible in current projection;
19. deleting every materialized/cache projection and recomputing from the same durable history + same fresh observations gives the same result;
20. changing only current external reality changes current projection deliberately.

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


## Runless DONE remains representable, but must be key-bound

The semantic-identity layer still permits a normalized `DONE + no run` lifecycle because a future non-run producer may provide exact key-bound realization evidence.

That representation does **not** authorize the realization projector to mint such a state from a bare observation.

```text
key-bound runless DONE
    ├── verified-content   -> may resolve
    └── settlement-receipt -> unresolved

bare observation
    -> cannot mint key-bound DONE
```

The distinction between realization provenance and settlement provenance remains useful; the integration falsification narrowed how realization provenance may be established.


## Final result

**Lean earns current realization projection.**

Evaluated implementation head:

`3ced4d0b6be709fbbbf75cecf9e792847337abb6`

Exact-head evidence:

- realization projection push run `35427385176`: **PASS**
- realization projection PR run `35427387191`: same exact head, dedicated workflow
- semantic identity `35427387184`: **PASS**
- obligation-key preimage `35427387233`: **PASS**
- claim admission `35427387222`: **PASS**
- existing Lean semantic kernel `35427387185`: **PASS**
- repository Evidence `35427387228`:
  - fast deterministic regression: **PASS**
  - adversarial local proofs: **PASS**
  - TLA+ safety proof: **PASS**

The dedicated projector workflow exercised:

- proof compilation;
- native projector execution;
- corrected TypeScript differential;
- producer-independent semantic identity;
- parent semantic identity differential;
- parent obligation-key preimage differential;
- parent claim-admission differential.

## What the experiment established

### 1. Historical replay and current realization truth are different projections

The existing runtime gap remains deliberately visible:

```text
historical DONE
external mutable state drifts
fresh GitOvercenterKernel reconstruction
→ historical projection still says DONE
```

That is not the desired current-truth projection.

The corrected architecture is:

```text
durable facts
    ↓
historical replay
    ↓
historical execution legality
    +
current semantic key
    +
fresh normalized observation
    ↓
current realization projection
```

Deleting materialized state is therefore expected to reconstruct the same **current** projection only when both durable history and current authoritative observations are the same.

If external reality changes, current projection may and should change.

### 2. Mutable DONE now has a machine-checked freshness invariant

Lean proves generically:

> If a mutable-external realization projects DONE, there exists a fresh observation and Lean's own settlement semantics classify that observation DONE.

It also proves that a mutable realization with no fresh observation cannot project DONE.

This closes the semantic hole demonstrated by `reuse-gap.test.ts` without treating failed reuse as permission to execute.

For a matching historical mutable DONE:

```text
fresh verified       -> DONE
fresh authoritative absence -> UNREALIZED
fresh uncertain      -> RECOVERY_REQUIRED
no fresh observation -> RECOVERY_REQUIRED
```

### 3. Producer-independent realization requires exact-key provenance

The initial challenger allowed fresh authoritative observation to establish `DONE + no run`. Integration falsified that rule.

A run is not the only possible realization producer, but some durable or otherwise authoritative evidence must bind a realization to the exact semantic obligation key.

The current implementation has one such source today: a matching historical run. A future human/foreign-producer adoption path needs an explicit realization certificate. It must not be inferred merely because the current postcondition happens to verify.

### 4. Failed reuse is not automatically safe re-execution

The experiment preserves an important asymmetry.

For a known historical DONE realization:

```text
uncertain current readback
        ↓
RECOVERY_REQUIRED
```

For a never-realized obligation:

```text
uncertain/non-verifying current observation
        ↓
UNREALIZED
```

The latter remains executable under normal admission/effect policy.

Without this distinction, providers whose collection APIs cannot prove negative evidence, such as the tested GitHub status semantics, could deadlock before their first mutation.

### 5. Stale active execution cannot disappear

A nonterminal execution remains safety-relevant even when:

- the current semantic key changes; or
- the current semantic key becomes unresolved.

Those cases project RECOVERY_REQUIRED rather than UNREALIZED.

That prevents semantic-key drift from erasing a possibly mutating execution attempt and accidentally admitting a second attempt.

## State-model finding

The existing operator word `RECOVERY_REQUIRED` remains usable, but the existing notion of a single associated `run` is not sufficient for current realization projection.

The experiment therefore makes two identities explicit:

```text
source_run_id
    provenance supporting the realization judgment

execution_run_id
    live execution authority, if one exists
```

For uncertain revalidation of a historical DONE:

```text
lifecycle        = RECOVERY_REQUIRED
source_run_id    = old terminal run
execution_run_id = null
```

For a stale active execution:

```text
lifecycle        = RECOVERY_REQUIRED
source_run_id    = active run
execution_run_id = active run
```

This distinction is material. A runtime adapter must never pass a terminal historical source run to execution-authority recovery merely because the operator status says RECOVERY_REQUIRED.

So the lifecycle vocabulary does **not** need another top-level status, but production migration needs realization provenance and execution authority represented separately.

## TypeScript null hypothesis

A corrected TypeScript implementation can express the same projection rules and agrees with Lean on the frozen hostile suite.

TypeScript therefore does not lose because the rules are impossible to implement there.

Lean earns the boundary because:

1. this is truth-deciding semantic composition contiguous with the already-earned settlement / identity / key / admission kernel;
2. the key mutable-DONE freshness invariant is machine checked generically rather than represented only by cases;
3. keeping this decision in TypeScript would leave two authorities for whether a realization is currently true;
4. the Lean implementation consumes existing semantic decisions rather than growing provider-specific machinery.

The appropriate production shape is one semantic authority, not permanent differential voting.

## Earned semantic boundary after this experiment

```text
authenticated provider / durable facts
                │
                ▼
TypeScript deterministic normalization
  transport
  schema / structural validation
  provider-local evidence normalization
                │
                ▼
Lean semantic core
  provider evidence meaning already modeled
  settlement
  current realization projection
  key-bound realization revalidation
  semantic identity
  obligation-key preimage
  claim admission
  execution legality
                │
                ▼
commodity / physical mechanisms
  SHA-256
  Git / GitHub / Kubernetes transport
  credentials
  CAS / commit mechanics
  Go physical computation executor where earned
```

## Production consequence

This experiment does **not** silently replace `replayProjection()` or `deriveLifecycles()`.

A production migration should preserve historical replay for validating the durable event stream and add a current-realization layer consumed by:

- inspect;
- frontier derivation;
- semantic identity;
- claim admission.

After migration, the old TypeScript truth-deciding duplicates should be deleted or retained only as differential tests. Running two production authorities indefinitely would weaken the result.

## Interpretation

This appears to be the natural inward boundary we were looking for.

What remains outside Lean is now predominantly deterministic infrastructure or provider-owned normalization:

- authenticated I/O;
- structural schema validation;
- provider request construction;
- cryptographic primitives;
- Git transport;
- CAS;
- credentials;
- physical mutation and execution.

Further migration into Lean should not proceed by momentum. It should require discovery of another concrete truth-deciding judgment outside this boundary and a new falsifiable experiment showing why that judgment belongs inside.

## Corrected-head confirmation

The corrected integration boundary was re-evaluated at exact revision `57cacf8e3f0d94caebce82ff9149cc8e3ea880fc` and passed:

- realization projection: run `35430755032`;
- claim-admission audition: run `35430755021`;
- semantic identity: run `35430755079`;
- obligation-key preimage: run `35430755044`;
- Lean semantic kernel: run `35430755050`;
- repository Evidence (regression, local adversaries, TLA+): run `35430755029`;
- disposable-agent trust proof: run `35430755031`.

This supersedes the earlier “being re-evaluated” status. The evaluated revision is intentionally recorded separately from later documentation-only commits.
