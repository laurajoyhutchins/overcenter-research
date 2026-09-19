# Storage backend comparison

## Question

Does Git still deserve to sit on Overcenter's production hot path once durable fact traffic becomes frequent, or is Git better retained as a portable/auditable representation around a database-backed authority store?

This experiment compares two representations of the same append-only durable history:

```text
fact payload
    |
    +--> Git object commit + authority-ref CAS
    |
    +--> SQLite immutable fact row + authority-row CAS
```

The SQLite side deliberately does **not** store mutable lifecycle status. Project truth remains reconstructible from durable facts. Each append writes one immutable fact and advances one authority head in the same transaction.

## Compared paths

### Git current path

The Git side mirrors `src/storage/git-store.ts`:

1. `hash-object -w --stdin`
2. `mktree`
3. `commit-tree`
4. `update-ref <ref> <next> <expected>`

Each durable fact is therefore one Git commit and one exact compare-and-swap authority transition.

Replay is measured twice:

- **current replay**: `rev-list`, then per commit `rev-parse <commit>^` plus five `git show <commit>:<fact-path>` probes, matching the current `GitOvercenterKernel` projection path;
- **batched replay**: one `rev-list` plus one `git cat-file --batch` process for all candidate fact paths, to avoid treating the current read implementation as the best Git can do.

### SQLite path

The SQLite side uses:

- WAL mode;
- `synchronous=FULL`;
- one immutable `facts` row per durable fact;
- a singleton authority row containing exact `(head, seq)`;
- `BEGIN IMMEDIATE`;
- insert fact;
- conditional authority update against the expected head and sequence;
- commit or rollback.

The SQLite commit identity is a SHA-256 chain over the previous head, sequence, fact kind, and canonical payload. It is backend-local identity, not a replacement for semantic obligation identity.

## Invariants

The benchmark is invalid unless all representations replay the same generated fact stream to the same canonical history digest.

The safety check additionally requires:

- two contenders from the same expected head produce exactly one winner;
- a losing SQLite CAS leaves no fact row behind;
- killing the writer process after a committed prefix leaves Git with exactly that reachable prefix and a clean `git fsck`;
- reopening SQLite after the same `SIGKILL` yields `integrity_check = ok`, an authority sequence equal to the committed row count, and no broken parent links.

## Run

```sh
npm run bench:storage-backends
npm run test:storage-backend-safety
```

The benchmark is intentionally not part of normal CI. Its absolute timings are host-dependent and, for Git, especially sensitive to process-spawn cost and filesystem behavior.

## Result

See [`results/2026-09-19.md`](./results/2026-09-19.md).

The bounded conclusion is not that "SQLite is universally N times faster." It is:

> The current one-fact-per-Git-object/ref transaction path is not a credible production hot path. Batched Git replay removes most read amplification, but it does not remove the per-fact write cost. An append-only transactional database can preserve ordered immutable facts, exact authority CAS, reconstructibility, and crash-safe committed prefixes without paying that cost.

Git remains useful as an interchange, inspection, export, and independent reconstruction format.
