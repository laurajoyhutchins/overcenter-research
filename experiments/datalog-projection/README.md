# Datalog projection experiment

## Question

Can a meaningful slice of Overcenter's current project projection be expressed as
pure relational derivation over append-only durable facts, rather than as stored
lifecycle state?

This experiment is intentionally narrower than the TypeScript reference
mechanism. It tests one architectural claim:

> If project status is a projection, deleting every materialized status should
> leave enough durable facts to derive the same status again.

The implementation uses Soufflé Datalog 2.5.

## Boundary

The experiment starts at the **semantic-key boundary**.

```text
obligation contents
+ verifier semantics
+ selected semantic dependency identities
        |
        | deterministic semantic layer
        v
semantic obligation key
        |
        v
append-only facts
  definition(key, ordinal)
  dependency(definition, upstream)
  run(key, ordinal)
  receipt(disposition, ordinal)
        |
        | Soufflé
        v
current definition
latest receipt
exact-key reusable realization
dependency closure
lifecycle
eligibility
        |
        v
READY / BLOCKED / EXECUTING /
WAITING / RECOVERY_REQUIRED / DONE
```

Soufflé does **not** decide:

- how canonical semantic hashes are computed;
- whether provider observations are structurally valid;
- whether negative evidence is authoritative;
- whether a receipt may legally be admitted;
- static provider-effect conflict semantics;
- authority-ref CAS, execution fencing, or mutation ordering.

Those remain responsibilities of the existing semantic, admission, provider,
and authority layers.

This split is deliberate. Datalog is being tested as a projection engine, not
as a replacement for the transaction kernel.

## Input facts

All inputs are append-only.

### `definition(obligation, semantic_key, ordinal)`

Each durable definition or amendment. The greatest ordinal for an obligation is
its current definition.

### `dependency(downstream, definition_ordinal, upstream)`

Dependency edges belonging to one exact definition. Only edges from the current
definition participate in the current graph.

### `run(run_id, obligation, semantic_key, ordinal)`

Historical executions keyed by the exact semantic obligation identity they
attempted to realize.

### `receipt(run_id, disposition, ordinal)`

Settlement history for a run. The greatest receipt ordinal is the current
receipt for that run.

The ordinal is a flattened stand-in for the total order already supplied by
authoritative Git history in the reference mechanism. The experiment does not
claim that arbitrary unordered event sets are sufficient.

## Derived relations

The program derives:

- the current definition for every obligation;
- current dependency edges;
- transitive dependency closure;
- the latest receipt for every run;
- historical runs whose semantic key still matches current meaning;
- producer-independent exact-key `DONE` reuse;
- current lifecycle;
- unsatisfied dependencies;
- public project status.

There is intentionally no producer relation. A human, agent, or previous run
has no semantic privilege here. If its durable realization fact carries the
same semantic key and its latest receipt is `DONE`, the realization is
reusable.

## Differential proof

`projection.test.ts` flattens bounded histories into Soufflé facts and compares
the resulting project status against the existing TypeScript
`deriveLifecycles() + projectWork()` implementation.

The hostile fixtures cover:

1. transitive dependency closure;
2. historical exact-key realization reuse;
3. semantic amendment invalidating an old `DONE` realization;
4. an unsettled matching run remaining `EXECUTING`;
5. `WAITING` and `RECOVERY_REQUIRED` lifecycle recovery;
6. authoritative absence returning work to `READY`;
7. append-only receipt history where later `DONE` supersedes an earlier
   recovery receipt.

The semantic-amendment case is the key negative control:

```text
definition a @ key K1
        |
old run K1 -> DONE
        |
amend material input
        v
definition a @ key K2

K1 != K2
   |
   v
old DONE is invisible to current reuse
   |
   v
READY
```

No invalidation flag or cache eviction is required. The old realization remains
a durable historical fact; it simply no longer joins against current meaning.

## Running

Requires Soufflé 2.5 on `PATH`.

```sh
npm run test:datalog
```

The dedicated GitHub Actions workflow installs the Ubuntu 24.04 Soufflé 2.5
release package and runs the differential test.

## What a green run means

A green run supports a bounded implementation claim:

> For the modeled lifecycle and dependency slice, current project status can be
> recomputed declaratively from append-only facts and semantic identity, and
> agrees with the current TypeScript reference mechanism on the tested hostile
> histories.

It does **not** prove the Datalog rules complete for all Overcenter semantics,
nor that Soufflé should become a production dependency. If the experiment
continues to absorb projection logic without absorbing authority or provider
state machines, that is evidence that the architectural boundary is real.
