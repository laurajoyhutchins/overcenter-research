# Producer-independent realization reuse

## Question

Can a verified realization satisfy a current obligation without executing another
worker, regardless of whether the producer was an agent, a human, or an older
run?

The reuse decision must depend on material semantics and verified evidence, not
producer identity or a materialized cache.

## Model

The proof separates three things that the current run/receipt path partially
conflates:

```text
obligation semantics K
        │
        ▼
verified realization X
        │
        ▼
 reusable satisfaction

producer identity ─────── audit provenance only
```

`K` is a canonical digest over:

- the work packet;
- selected semantic-dependency identities;
- exact verifier identity/version;
- material configuration;
- source inputs;
- the acceptance predicate; and
- the reuse mode.

The scheduling obligation id and producer identity are intentionally not
material to realization identity.

A content-addressed realization is admitted only after its bytes satisfy the
declared acceptance predicate. Agent, human, and previous-run candidates that
produce the same accepted bytes therefore emit the same semantic realization
fact.

## Executable claims

`npm run test:realization` proves:

1. agent, human, and previous-run producers generate byte-for-byte identical
   verified realization evidence for the same accepted output;
2. semantic-dependency declaration order is irrelevant, while changing a
   dependency identity changes `K` and removes reuse;
3. changing verifier identity/version, material configuration, source input,
   acceptance predicate, or packet changes `K` and removes reuse;
4. an `external-effect` contract cannot be minted as a reusable realization,
   and even a hostile fact with the exact external-effect key is ignored with
   `CURRENT_OBSERVATION_REQUIRED`; and
5. reuse reconstructs identically from durable Git realization facts after a
   materialized reuse index is deleted.

## What this does not yet prove

This branch deliberately does not wire realization facts into
`GitOvercenterKernel`.

The current lifecycle model still discovers historical completion through
`HistoricalRun` plus a `DONE` receipt. That is run-derived completion, not
the producer-independent realization model proved here.

That integration should be a separate step because it must answer two safety
questions explicitly:

1. which existing postconditions denote reusable, content-addressed
   realizations rather than mutable external state; and
2. how current-definition completion remains `DONE` while historical
   external-effect receipts stop acting like cache hits across semantic
   revisions.

Until those are resolved, this proof is a semantic primitive and adversarial
boundary test, not a claim that the runtime already performs safe
producer-independent reuse.
