# ADR-0001: Use one storage-neutral kernel execution loop

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Overcenter had a backend-specific `runGitCoreLoop` name in addition to the storage-neutral `runCoreLoop`. Both represented the same project-transition semantics.

The [storage backend comparison](../../experiments/storage-backend-comparison/README.md) and its [2026-09-19 results](../../experiments/storage-backend-comparison/results/2026-09-19.md) showed that Git and SQLite can preserve the same append-only fact semantics, exact compare-and-swap authority, canonical replay, and crash-safe committed prefixes while having very different performance characteristics.

The follow-on backend differential test in [`test/kernel-backend-differential.test.ts`](../../test/kernel-backend-differential.test.ts) checks the same logical transitions through both stores.

## Decision

Project-transition execution has one production owner: `runCoreLoop`.

Storage implementations sit behind `DurableFactStore` and may differ physically without receiving their own copies or aliases of project semantics.

```text
project semantics
      |
      v
   runCoreLoop
      |
 DurableFactStore
   /         \
SQLite       Git
production   reference
```

`runGitCoreLoop` is removed. The Git and SQLite kernels both use `runCoreLoop`.

## Consequences

Backend differential tests vary storage while holding transition semantics fixed. A new storage backend does not earn a new execution loop merely because its persistence mechanics differ.

Git remains a reference/replay backend. This ADR does not require deleting `GitFactStore`.

## Rejected alternatives

Keeping `runGitCoreLoop` as a compatibility alias was rejected because it gives the same semantic rule two public names and invites backend-specific drift.

Moving storage-specific behavior into `runCoreLoop` was also rejected. Storage mechanics belong below the semantic kernel.

## Revisit when

Revisit only if an experiment demonstrates that a storage backend genuinely requires different project-transition semantics rather than different persistence mechanics.
