# Durable authority facts contract v1

This package defines the persisted logical facts from which Overcenter reconstructs project truth.

Shape validity is necessary but not sufficient. A well-shaped claim can still be stale, an execution-authority fact can still name the wrong predecessor, and a receipt can still fail settlement semantics. Those history-sensitive rules remain in `src/projection.ts`.

## Persisted facts

The logical fact vocabulary is:

```text
graph-patch.json
claim.json
execution-authority.json
effect-reservation.json
receipt.json
```

Git and SQLite are storage implementations of this logical history. Backend-local commit identifiers are intentionally not interchangeable.

## Graph patches

`graph-patch.json` is the only persisted graph-definition transition. It contains:

- content-addressed immutable obligation definitions;
- stable node-to-definition bindings;
- stable node IDs retired from the current graph.

A graph revision may rebind a node or retire it, but it never mutates or deletes a definition. Definitions remain available for historical run interpretation and later reuse.

## Open boundaries

The outer fact envelopes reject unknown fields. Four nested payloads remain deliberately open:

- `GraphPatchFact.definitions[].definition.packet`: application-defined and authoritative by value.
- `GraphPatchFact.definitions[].definition.postcondition`: owned by verifier contracts.
- `ReceiptFact.observed`: owned by the observation/evidence contract.
- `ReceiptFact.diagnostic`: intentionally non-authoritative diagnostics.

Open does not mean ungoverned. The first three can affect identity or settlement and therefore need their own referenced contracts. They are not extension buckets for arbitrary outer fact fields.

## Receipt schema

Overcenter accepts and writes `overcenter-git-receipt-v5`. Observation evidence is validated against the current observation/evidence contract before replay.

`disposition`, `verified`, and `settlement_commit` are projection results. They are not persisted receipt fields and must never be accepted as if a worker could write settlement truth directly.

## Conformance

`authority-fact-conformance.json` exercises the runtime validators against valid and hostile outer envelopes. Storage differential tests separately prove that Git and SQLite preserve the same logical fact history.
