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

## Worker admission

The core loop now selects execution semantics from the obligation rather than
asking the worker which path to use.

For `realization-content/v1`:

```text
READY
  │
  ▼
realizationWorker(packet)
  │
  ▼
candidate bytes
  │
  ▼
recordRealization @ exact revision
  │
  ▼
verified realization fact
  │
  ▼
DONE
```

This path deliberately creates no claim, execution permit, effect reservation,
or observation receipt. Candidate generation is computation, not authoritative
mutation. The worker cannot make the project `DONE`; only deterministic
verification plus authority-ref CAS can do that.

For mutable effects, the existing path remains unchanged:

```text
claim → reserve → effect → observe → settle
```

The distinction is mechanically selected from the postcondition class. A worker
cannot downgrade a mutable provider effect into the cheaper realization path.

The adversarial proof also demonstrates reuse at the worker boundary: two
equivalent obligations execute the worker once, commit one realization fact,
and both project `DONE`. A rejected candidate leaves the obligation `READY`
and creates no run or effect facts.

## Immutable artifact materialization

Admission now commits two different things with different roles:

```text
realization.json
  semantic evidence and reuse authority

realization.artifact
  immutable payload bytes
```

The payload does not decide whether an obligation is satisfied. The verified
realization fact does. But a fact is not admitted into reusable projection
unless the reachable payload hashes to the exact SHA-256 carried by that fact.

That gives materialization the fail-closed rule:

```text
fact + reachable bytes + matching digest
                  │
                  ▼
          reusable + materializable

missing bytes OR digest mismatch
                  │
                  ▼
             no valid replay
```

The artifact is a raw Git blob reachable from the same immutable realization
commit. Because it is reachable from the authority ref, ordinary Git object
transport carries it to a fresh clone without a separate cache protocol.
`materializeRealization("sha256:…")` resolves the validated realization back
to those bytes and verifies the digest again at the read boundary.

The reconstruction proof deletes the materialized cache, fetches only the
authority ref into a fresh bare repository, reconstructs `DONE`, materializes
the same bytes by identity, and confirms that the realization worker executes
zero additional times.

This deliberately keeps storage identity out of the semantic fact. A Git object
ID is a transport/storage detail; the reusable identity remains SHA-256 over the
artifact content. Another immutable object store could replace Git without
changing obligation meaning.

## What this still does not prove

The integration does not yet prove that:

- arbitrary postcondition kinds can be classified safely as reusable or
  external-effect semantics;
- realization workers are physically sandboxed or receive a task-specific
  executable capability rather than an in-process callback;
- binary or large artifacts are handled efficiently. The reference candidate
  and Git transport currently use UTF-8 strings;
- an external artifact store has correct retention, garbage collection, or
  availability semantics;
- every verifier can safely reconstruct its material configuration and source
  closure; or
- artifact availability can survive authority-history pruning without a
  separate retention root.

The next implementation step for autonomous software development is physical
isolation of the realization worker behind a task-scoped executable capability,
with an artifact transport contract that preserves the same immutable identity
boundary.
