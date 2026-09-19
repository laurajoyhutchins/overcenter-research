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

## Kernel integration

The kernel now consumes the same durable realization facts during lifecycle
projection.

A historical run receipt is intentionally narrower than a realization fact:

```text
DONE receipt
  authority: exact obligation definition that produced the run

verified realization
  authority: any current obligation whose material realization key matches
```

This removes the previous accidental equivalence between "same obligation key"
and "safe cache hit." A same-key receipt from an older definition remains
factual execution history but does not make the amended obligation `DONE`.

Reusable semantics are opt-in on the obligation and use a dedicated
`realization-content/v1` postcondition. The declaration supplies the verifier
identity, material configuration, source inputs, and acceptance predicate;
packet and selected semantic-dependency identities come from the current
graph. The postcondition digest and acceptance-predicate digest must agree, and
the kernel verifies a candidate against that contract before committing
`realization.json`.

Mutable postconditions are barred from that path. File coordinates, GitHub
commit-status effects, and eventually-consistent provider state remain
observation-driven and fail admission if marked reusable. Realization-only completion also cannot satisfy a
semantic edge that explicitly consumes a settlement receipt, because no receipt
was produced.

Projection exposes `realization_identity` separately from `run_id`, so a
consumer can tell whether `DONE` came from exact execution settlement or
producer-independent realization reuse.

## What this still does not prove

The integration does not yet prove that:

- arbitrary postcondition kinds can be classified safely as reusable or
  external-effect semantics;
- worker execution automatically emits a reusable candidate after successful
  computation;
- the realization fact is a storage system for large artifact bytes. The proof
  stores evidence identities, not an artifact CAS;
- every verifier can safely reconstruct its material configuration and source
  closure; or
- a reusable realization remains available forever in an external artifact
  store merely because its evidence fact remains durable.

The next implementation step for autonomous software development is therefore
to make the worker return a candidate realization through a deterministic
admission boundary, then materialize the accepted artifact by immutable
identity rather than rerunning the worker.
