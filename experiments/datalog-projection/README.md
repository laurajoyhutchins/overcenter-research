# Datalog projection experiment

## Question

Can a meaningful slice of Overcenter's current project projection be expressed as
pure relational derivation over durable history plus recomputed semantic judgments,
rather than as stored lifecycle state?

This experiment is intentionally narrower than the TypeScript reference
mechanism. It tests one architectural claim:

> If project status is a projection, deleting every materialized status should
> leave enough durable facts to derive the same status again.

The implementation uses Soufflé Datalog 2.5.

## Boundary

The experiment starts at the **semantic-key boundary**.

```text
current obligation definition
+ verifier semantics
+ selected upstream realization identities
        |
        | deterministic semantic layer
        v
current_semantic_key(obligation, key)
        |
        +-------------------------------+
                                        |
append-only durable history             |
  definition(definition_id, ordinal)    |
  dependency(definition_id, upstream)   |
  run(key, ordinal)                     |
  receipt(kind, ordinal)                |
        |                               |
semantic judgments                      |
  current_semantic_key                  |
  observation_judgment                  |
  current_realization_admissible        |
        |                               |
        +---------------+---------------+
                        |
                        v
                  Soufflé Datalog
                        |
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

The distinction matters. A definition does **not** own one permanent semantic
key. The same unchanged downstream definition can acquire a different current
key when a selected upstream realization identity changes. Therefore the
semantic key is supplied as current derived input rather than stored on the
definition relation.

Soufflé does **not** decide:

- how canonical semantic hashes are computed;
- which selected upstream identities contribute to a semantic key;
- whether provider observations are structurally valid;
- whether negative evidence is authoritative;
- whether a receipt may legally be admitted;
- static provider-effect conflict semantics;
- authority-ref CAS, execution fencing, or mutation ordering.

Those remain responsibilities of the existing semantic, admission, provider,
and authority layers.

This split is deliberate. Datalog is being tested as a projection engine, not
as a replacement for the transaction kernel or semantic verifier.

## Inputs

Durable history inputs are append-only. Recomputed semantic inputs carry
judgments owned outside Datalog: current obligation identity, the meaning of an
observation receipt, and whether a historical realization is admissible *now*.
None is stored lifecycle state.

### `definition(obligation, definition_id, ordinal)`

Each durable definition or amendment. The greatest ordinal for an obligation is
its current definition. `definition_id` identifies that exact durable
definition; it is not the semantic obligation key.

### `dependency(downstream, definition_id, upstream, kind)`

Dependency edges belonging to one exact definition. Only edges from the current
definition participate in the current graph. `kind` retains the minimal
`control | semantic` distinction: both gate execution, but only an unresolved
semantic edge can make the current semantic key legitimately unavailable.

### `run(run_id, obligation, semantic_key, ordinal)`

Historical executions keyed by the exact semantic obligation identity they
attempted to realize.

### `receipt(run_id, kind, ordinal)`

Durable receipt history for a run. This carries the stored receipt kind only:
`observation`, `judgment-required`, or `execution-terminated`. **Disposition is
not an input.** The greatest receipt ordinal is the current receipt for that run.

### `current_semantic_key(obligation, semantic_key)`

Current semantic identity produced by the existing deterministic semantic
layer. This relation is intentionally **not** append-only historical state.
It is recomputed from current obligation meaning, including selected upstream
realization identities. It may be absent while a semantic dependency is not
`DONE`; that is a normal `BLOCKED` condition, not malformed input. Once all
semantic dependencies are resolved, a missing key fails closed.

### `observation_judgment(run_id, receipt_ordinal, verified, accepted_absence)`

A recomputed semantic judgment over one durable observation receipt. Provider
and verifier code owns whether the exact postcondition is verified and whether
negative evidence is authoritative and accepted by policy. Datalog maps those
facts to settlement disposition. A missing or contradictory judgment fails
closed.

### `current_realization_admissible(run_id, obligation)`

A recomputed realization-stability judgment. Exact semantic-key equality plus a
historical `DONE` receipt is **not** sufficient by itself. Immutable
realizations may remain admissible indefinitely; mutable external state may
require fresh authoritative observation. Datalog therefore derives current
`DONE` only from a matching historical settlement that is also currently
admissible.

This deliberately follows the stronger target semantics exposed by the Lean
experiment rather than freezing the current TypeScript stale-mutable-reuse gap
into another implementation.

The ordinal is a flattened stand-in for the total order already supplied by
authoritative Git history in the reference mechanism. The experiment does not
claim that arbitrary unordered event sets are sufficient.

## Derived relations

The program derives:

- the current definition for every obligation;
- current dependency edges;
- transitive dependency closure;
- the settlement disposition of each receipt from receipt kind plus normalized
  observation judgment;
- the latest receipt for every run;
- historical runs whose semantic key still matches current meaning;
- current `DONE` only when a matching settled realization is also currently
  admissible;
- current lifecycle;
- unsatisfied dependencies;
- public project status;
- diagnostics for missing or contradictory flattened inputs.

There is intentionally no producer relation. Producer identity has no semantic
privilege once a realization has been admitted. Reuse depends on exact current
meaning, accepted settlement evidence, and current realization admissibility.

## Differential proof

`projection.test.ts` flattens bounded histories into Soufflé facts and compares
the resulting project status against the existing TypeScript
`projectReceipt() + deriveLifecycles() + projectWork()` implementation. The
fixtures provide raw receipt kinds and concrete observation evidence; they do
not provide the expected disposition to Soufflé.

The hostile fixtures cover:

1. transitive dependency closure and preservation of the minimal
   control/semantic edge distinction;
2. historical exact-key realization reuse;
3. semantic amendment invalidating an old `DONE` realization;
4. the **same unchanged definition** receiving a different current semantic
   key and therefore losing reuse;
5. an unsettled matching run remaining `EXECUTING`;
6. `WAITING` and `RECOVERY_REQUIRED` lifecycle recovery;
7. authoritative absence returning work to `READY`;
8. uncertain observation remaining `RECOVERY_REQUIRED`;
9. append-only receipt history where later verified evidence supersedes an
   earlier recovery receipt;
10. missing semantic judgment and contradictory identity failing closed;
11. the known TypeScript mutable-reuse gap: TypeScript still projects historical
    `DONE`, while Datalog can project `READY` when the semantic layer withdraws
    current realization admissibility after external drift.

The same-definition identity-change case is the important negative control:

```text
downstream definition D
        |
current semantic key K1
        |
old run K1 -> DONE
        |
selected upstream realization changes
        |
semantic layer recomputes current key K2
        |
        +---- definition is still D

K1 != K2
   |
   v
old DONE no longer joins current meaning
   |
   v
derive current eligibility again
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
> recomputed declaratively from durable history plus normalized semantic
> judgments, without accepting lifecycle or disposition as input. It agrees
> with TypeScript where their semantics overlap and can represent the stronger
> fail-closed realization-reuse rule already exercised by Lean.

It does **not** prove the Datalog rules complete for all Overcenter semantics,
nor that Soufflé should become a production dependency. In particular, Datalog
intentionally does not infer whether a historical claim was legal from current
realization admissibility; that temporal authority question belongs to the
transaction/history validator. If the experiment
continues to absorb projection logic without absorbing authority, semantic
hashing, or provider state machines, that is evidence that the architectural
boundary is real.
