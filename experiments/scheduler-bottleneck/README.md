# Scheduler bottleneck decomposition

## Question

The scheduler-scaling experiment showed that the current end-to-end production path is nearly flat at two workers and regresses sharply at four and eight. Is the dominant limit SQLite's single-writer authority transaction, or repeated history reconstruction/projector work above it?

## Design

This experiment decomposes the path without changing production semantics.

### 1. History scan

Use the production `SqliteFactStore` with inert append-only facts and measure `history(head)` at 10, 100, 1,000, and 5,000 durable commits.

This isolates SQLite row retrieval, JSON parsing, digest verification, and parent/sequence verification.

### 2. Projection replay

Construct valid obligation-definition fact histories in memory and measure production `replayProjection()` at 1, 8, 32, 64, and 128 definitions.

This removes SQLite from the timed interval and exposes replay/projector growth.

### 3. Full READY read

Populate the production `OvercenterKernel` with 1, 8, 32, and 64 definitions, then measure `deriveReadyWork()`.

This is the scheduler-facing read path and includes durable history reconstruction plus current project projection.

### 4. Bare authority CAS

Use `SqliteFactStore` directly from 1, 2, 4, and 8 independent processes. Each case performs exactly 4,096 durable appends through the same authority row.

There is no graph, observation, scheduler, or project projection in this path. It isolates the serialized SQLite transaction/CAS ceiling and records stale/busy retry pressure.

## Interpretation

The four measurements answer different questions:

```
history(head)        -> storage reconstruction cost
replayProjection     -> semantic replay/projector cost
deriveReadyWork      -> combined scheduler read cost
bare append CAS      -> SQLite authority writer ceiling
```

If bare CAS throughput remains far above end-to-end scheduler throughput while READY latency grows rapidly with graph/history size, the next repair belongs in projection/reconstruction rather than distributed authority.

If bare CAS itself collapses at small writer counts, authority-transition amortization becomes independently justified.

## Reproduce

```sh
npm run experiment:scheduler-bottleneck
```

Absolute timings are host-dependent. Relative decomposition is the claim.

## Non-claims

- This does not prove a production performance SLO.
- This does not prove distributed SQLite or HA.
- Synthetic definition histories do not represent every graph topology.
- A bottleneck diagnosis does not itself authorize an optimization.

## Hosted result

Exact evaluated revision: `eee41cac304acffa453c6e37883153a6498fea24`

GitHub Actions run: `35540980827` on Ubuntu 24.04 / Node 22.16.0.

### Durable history scan

| Commits | Median |
| ---: | ---: |
| 10 | 0.070 ms |
| 100 | 0.497 ms |
| 1,000 | 5.318 ms |
| 5,000 | 25.953 ms |

Above 100 commits, the scan is close to linear at about 5.2 microseconds per durable commit.

### Semantic replay

| Definitions | Median replay |
| ---: | ---: |
| 1 | 0.171 ms |
| 8 | 0.658 ms |
| 32 | 6.778 ms |
| 64 | 23.363 ms |
| 128 | 78.755 ms |

Doubling the flat graph from 32 to 64 definitions increases replay by about 3.4x; 64 to 128 increases it by another ~3.4x. The cost per definition therefore rises with project size rather than remaining constant.

### Production READY read

| Definitions | Median `deriveReadyWork()` |
| ---: | ---: |
| 1 | 0.113 ms |
| 8 | 1.395 ms |
| 32 | 5.986 ms |
| 64 | 21.553 ms |

The scheduler-facing read follows the same growth pattern as semantic replay.

### Bare authority CAS

Each writer-count case uses 4,096 durable appends on a fresh database and reports the median of three trials.

| Writers | Appends/s | Speedup | Efficiency | Median stale retries |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2,387.857 | 1.000x | 1.000 | 0 |
| 2 | 2,245.884 | 0.941x | 0.470 | 3 |
| 4 | 1,878.101 | 0.787x | 0.197 | 4 |
| 8 | 1,297.630 | 0.543x | 0.068 | 6 |

SQLite's single-writer authority does not scale positively with more writers, but its absolute transaction capacity remains orders of magnitude above the current end-to-end scheduler.

The preceding scheduler-scaling experiment measured about 7.9 claim-through-settlement transactions/s at one worker and 2.25/s at eight. At the same worker counts, this bare authority experiment supplies roughly 300x and 575x more durable append capacity respectively.

## Diagnosis

The present bottleneck is **not bare SQLite authority serialization**.

The dominant evidence points at repeated reconstruction and semantic projection above the store:

```
SQLite append capacity         thousands / second
history scan                   approximately linear
semantic replay                increasingly expensive per obligation
deriveReadyWork                tracks semantic replay growth
full scheduler transaction     single-digit / second
```

The next optimization should therefore target reconstruction/projection work first, while preserving the durable-facts-as-authority model. Distributed authority or HA may become relevant later, but the current scheduler would carry its much larger local replay cost into that architecture unchanged.
