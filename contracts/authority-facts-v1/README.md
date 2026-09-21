# Durable authority facts contract v1

This package defines the persisted logical facts from which Overcenter reconstructs project truth.

Shape validity is necessary but not sufficient. A well-shaped claim can still be stale, an execution-authority fact can still name the wrong predecessor, and a receipt can still fail settlement semantics. Those history-sensitive rules remain in `src/projection.ts`.

## Persisted facts

The logical fact vocabulary is:

```text
obligation.json
claim.json
execution-authority.json
effect-reservation.json
receipt.json
```

Git and SQLite are storage implementations of this logical history. Backend-local commit identifiers are intentionally not interchangeable.

## Legacy wire names

Several persisted discriminators contain `overcenter-git-*`. Those are historical wire names, not current architectural authority. Renaming them would make old durable history incompatible for cosmetic benefit, so this contract preserves them. New persisted families should not inherit a storage-backend name unless the backend is actually part of their semantics.

## Open boundaries

The outer fact envelopes reject unknown fields. The remaining open nested payloads are:

- `Obligation.packet`: application-defined and authoritative by value.
- `ReceiptFact.observed`: owned by the observation/evidence contract.
- `ReceiptFact.diagnostic`: intentionally non-authoritative diagnostics.

`Obligation.postcondition` is closed by the `postconditions-v1` contract. Unknown nested fields are rejected before an obligation fact is admitted.

## Obligation schema

Overcenter accepts `overcenter-git-obligation-v4`. Earlier obligation discriminators are rejected rather than adapted into the current contract.

## Receipt schema

Overcenter accepts and writes `overcenter-git-receipt-v5`. Observation evidence is validated against the current observation/evidence contract before replay.

`disposition`, `verified`, and `settlement_commit` are projection results. They are not persisted receipt fields and must never be accepted as if a worker could write settlement truth directly.

## Conformance

`authority-fact-conformance.json` exercises the runtime validators against valid and hostile outer envelopes. Storage differential tests separately prove that Git and SQLite preserve the same logical fact history.
