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
- `LegacyObligationV3.postcondition`: historical v3 replay remains permissive for compatibility.
- `ReceiptFact.observed`: receipt-v5 is owned by the observation/evidence contract; receipt-v4 remains permissive historical read data.
- `ReceiptFact.diagnostic`: intentionally non-authoritative diagnostics.

Current obligation-v4 writes are different: `Obligation.postcondition` is closed by the `postconditions-v1` contract. Unknown nested fields are rejected before a new obligation fact is written.

## Obligation compatibility

Overcenter writes `overcenter-git-obligation-v4` and continues to read v3. The v4 discriminator closes the postcondition boundary without retroactively invalidating v3 history.

## Receipt compatibility

Overcenter writes `overcenter-git-receipt-v5` and continues to read `v4` for historical replay. The v4/v5 distinction is semantically meaningful because absence evidence is treated differently during replay.

`disposition`, `verified`, and `settlement_commit` are projection results. They are not persisted receipt fields and must never be accepted as if a worker could write settlement truth directly.

## Conformance

`authority-fact-conformance.json` exercises the runtime validators against valid and hostile outer envelopes. Storage differential tests separately prove that Git and SQLite preserve the same logical fact history.
