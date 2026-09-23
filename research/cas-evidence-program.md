# CAS evidence research program

The content-addressed evidence work is one research program with deliberately staged production promotion. Each stage should stay narrower than the conclusion established by its gate.

## Program thesis

Overcenter can keep large immutable evidence outside authoritative state without introducing a distributed transaction if publication is asymmetric:

```text
immutable evidence bytes
        |
        | durable publication
        v
content-addressed EvidenceStore
        |
        | exact EvidenceRef
        v
authoritative reference
```

An unreferenced evidence object is recoverable garbage. An authoritative reference to evidence that was never durably published is not an acceptable publication state.

The durable invariant is therefore:

> Authority may reference an external immutable object only after durable publication of that object has completed.

The `EvidenceStore` identifies and verifies bytes. It does not decide which evidence is authoritative or live.

## Promotion chain

### #299: narrow production storage primitive

PR #299, **Add content-addressed evidence store**, is the first production promotion from the earlier Merkle/evidence investigations.

Its production responsibility is intentionally small:

- define backend-neutral `EvidenceRef { algorithm, digest, byte_length }`;
- publish and verify immutable bytes through `EvidenceStore`;
- provide the initial local `FileEvidenceStore`;
- reject corruption and malformed references;
- clean stale temporary publication files.

It does not migrate receipts, change settlement, redefine project truth, or make the evidence store authoritative.

This stage answers: **can Overcenter safely identify and persist immutable evidence bytes as a reusable primitive?**

### #300: publication-protocol gate

PR #300, **Experiment: evidence-first authority publication**, gates the first use of that primitive across the authority boundary.

The preregistered experiment requires:

1. publish evidence durably;
2. receive its exact `EvidenceRef`;
3. only then append the authoritative reference.

Hosted evaluation at exact revision `eea803191db2eeec4a93807ab810c8d8a1ba88b6` supported the bounded claim:

- SIGKILL after evidence publication but before authority append left authority unchanged and only an orphan object;
- SIGKILL after authority append left a valid authoritative reference to verifiable evidence;
- two writers from one expected authority head produced exactly one authority winner;
- the losing evidence object was collectible after the race quiesced;
- deleting referenced evidence caused resolution to fail closed;
- no tested history became invalid.

This stage answers: **can durable evidence publication and authoritative reference publication remain separate transactions without creating an unsafe cross-store state?**

It does not establish safe online garbage collection concurrent with in-flight publishers, power-loss semantics beyond the storage primitive's durability contract, remote replication, or receipt migration.

## Next gates

### Online reachability and garbage collection

Before production orphan collection runs concurrently with publishers, test the collector against in-flight publication.

The falsifying trace is:

```text
writer publishes evidence
        |
collector observes no authority reference
        |
collector deletes evidence
        |
writer appends authority reference
        v
dangling authoritative reference
```

A production collector therefore needs a mechanism such as an in-flight publication fence, epoch, grace interval tied to the publication contract, or another deterministic exclusion rule. Quiescent collectibility from #300 is not sufficient evidence for online GC.

### Receipt integration

Only after the publication and reachability gates should production receipts begin referring to external evidence.

Migration should be additive:

- historical inline receipts remain valid;
- new receipt forms may carry `EvidenceRef`;
- authority continues to decide which evidence counts;
- missing referenced evidence fails closed;
- historical authority is not rewritten merely to adopt the new representation.

### Backend portability

A later backend may replace the local filesystem implementation, but it must satisfy the same publication contract before authority can depend on it. Backend-specific durability, identity, and corruption checks belong below the publication protocol rather than changing authority semantics.

## Program boundary

The program is not "make the evidence store the database." Its purpose is to separate immutable bytes from authoritative meaning while preserving deterministic publication correctness.

```text
EvidenceStore       owns immutable bytes + byte identity
Publication protocol owns ordering across the boundary
Authority           owns references + reachability + meaning
```

The promotion rule is evidence before widening: production code gains only the mechanism justified by the preceding gate, and the next semantic responsibility remains experimental until its own hostile test can falsify it.
