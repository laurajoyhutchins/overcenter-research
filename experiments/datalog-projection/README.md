# Datalog projection experiment

## Question

Can Overcenter derive current project status relationally instead of storing
lifecycle state?

This experiment uses Soufflé Datalog 2.5 to test one bounded claim:

> Given validated durable history plus recomputed semantic judgments, project
> status is a deterministic projection.

```text
validated durable history
  definitions
  dependencies
  runs
  receipt kinds
        +
recomputed semantic judgments
  current semantic key
  observation meaning
  current realization admissibility
        |
        v
     Datalog
        |
        +--> current definition
        +--> dependency closure
        +--> receipt disposition
        +--> exact-key realization match
        +--> lifecycle
        +--> eligibility
        |
        v
READY / BLOCKED / EXECUTING /
WAITING / RECOVERY_REQUIRED / DONE
```

Datalog accepts **no lifecycle status and no receipt disposition** as input.

## Boundary

The experiment starts after structural authority-history validation and
provider/verifier interpretation.

Datalog does **not** own:

- durable schema/reference validation;
- canonical semantic hashing;
- semantic-selector interpretation;
- provider observation validation;
- absence-certificate authority;
- realization-stability policy;
- static effect-conflict admission;
- execution fencing, mutation ordering, or CAS.

Those remain deterministic software outside the projection rules.

Three recomputed semantic inputs cross the boundary:

- `current_semantic_key(obligation, key)` binds the current obligation meaning;
- `observation_judgment(run, receipt, verified, accepted_absence)` reduces
  provider-specific evidence to provider-neutral settlement meaning;
- `current_realization_admissible(run, obligation)` says whether a settled
  realization is acceptable **now**.

The last relation matters because exact-key historical `DONE` is not sufficient
for mutable external state. Immutable realizations may remain reusable;
mutable state may require fresh authoritative observation. This matches the
stronger target semantics in the Lean experiment rather than freezing the
current TypeScript stale-mutable-reuse gap into Datalog.

## Minimal graph information

Dependency facts preserve one bit:

```text
control | semantic
```

Both kinds gate execution. Only semantic dependencies participate in semantic
identity, so a missing current semantic key is legitimate while a semantic
upstream remains unresolved.

No richer edge taxonomy is needed by this projection slice.

## Settlement

Durable receipts contribute only their stored kind:

```text
observation
judgment-required
execution-terminated
```

For an observation, the semantic layer supplies:

```text
verified  accepted_absence  -> disposition
true      false             -> DONE
false     true              -> READY
false     false             -> RECOVERY_REQUIRED
```

`judgment-required -> WAITING` and
`execution-terminated -> RECOVERY_REQUIRED`.

If the latest receipt cannot be interpreted uniquely, projection fails closed
to `RECOVERY_REQUIRED`.

## Differential evidence

`projection.test.ts` compares Soufflé with the current TypeScript
`projectReceipt() + deriveLifecycles() + projectWork()` path where their
semantics overlap.

The hostile cases cover:

1. transitive dependency closure;
2. unresolved semantic dependency with no current key;
3. exact-key admissible historical reuse;
4. material amendment invalidating historical reuse;
5. unchanged definition plus changed semantic key invalidating reuse;
6. `EXECUTING`, `WAITING`, and `RECOVERY_REQUIRED` reconstruction;
7. accepted authoritative absence returning work to `READY`;
8. uncertain observation remaining recovery-bound;
9. later verified observation superseding earlier recovery evidence;
10. missing observation interpretation failing closed;
11. the known TypeScript mutable-reuse gap, where Datalog can withdraw current
    realization admissibility and return the obligation to `READY`.

There is deliberately no invalidation operation. A historical realization can
remain in durable history while simply ceasing to join against current meaning.

## Running

Requires Soufflé 2.5 on `PATH`:

```sh
npm run test:datalog
```

The dedicated GitHub Actions workflow verifies the Ubuntu 24.04 Soufflé 2.5
package against:

```text
c7e9dd1349506bbb23c4dcf89e87396198006235f79b1cc516c0a2b67ac067bc
```

before installing it. On pull requests the workflow checks out and asserts the
exact PR head SHA rather than GitHub's synthetic merge ref, then runs the
differential test.

## What green means

A green run supports only this claim:

> For the modeled projection slice, validated history plus current semantic
> judgments is sufficient to recompute public project status without stored
> lifecycle or precomputed disposition.

It does not prove the Datalog rules complete for all Overcenter semantics, and
it does not establish Soufflé as a production dependency.
