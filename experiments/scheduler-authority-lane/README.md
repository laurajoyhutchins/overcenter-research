# Scheduler authority lane

## Question

Once exact claims are provisioned, should parallel workers also settle authority independently, or should uncertain/effectful work fan out while durable authority commits remain in one deterministic software lane?

## Hypothesis

Overcenter's own architecture says deterministic software should own execution correctness. If that boundary is real rather than rhetorical, parallelism should live around external effects, not around competing writes to one project-truth head.

## Design

The experiment uses the unchanged production `OvercenterKernel` and 32 independent local-file obligations.

Both modes first provision all exact claims serially through normal production `claim()`.

### Distributed settlement

Each worker receives the exact `ExecutionPermit`, performs its assigned effects, independently calls `resolve()`, and therefore races other workers to advance the global authority head.

### Single authority lane

Workers receive **only packet bytes**, not execution permits. They perform effects in parallel and report which assignments completed. The coordinator retains every exact permit, independently observes provider truth, and settles receipts serially through one production kernel.

The implementation deliberately settles only after the whole effect phase completes. This is conservative: it proves the architecture without depending on pipelined settlement.

## Effect-cost sweep

The same 1, 2, 4, and 8 worker cases run with artificial effect delays of:

- 0 ms, where authority overhead dominates;
- 25 ms, representing moderate external work;
- 100 ms, representing provider/network-heavy work.

The artificial delay occurs before the local-file mutation. Settlement still uses real production observation and durable receipt writes.

## Distinguishing criterion

If a single authority lane:

1. removes settlement contention,
2. preserves exact authority and independent observation,
3. and recovers positive N-way speedup as effect cost increases,

then the correct production direction is a software-owned assignment/settlement lane around a parallel effect pool, not increasingly clever multi-writer CAS retries.

If it remains flat even for expensive effects, the authority lane itself is too costly and needs further decomposition.

## Reproduce

```sh
npm run experiment:scheduler-authority-lane
```

## Non-claims

- Artificial delay is not a model of any specific provider.
- This does not prove fairness policy.
- The experiment does not make SQLite distributed or highly available.
- A single in-process authority lane is not necessarily the final deployment topology.
- The experiment does not authorize trusting worker-reported success; settlement independently observes the postcondition.


## Hosted result

Exact evaluated revision: `fd9350a52217fbd612b51c364591a35b1285dd0e`

GitHub Actions run: `35570781339` on Ubuntu 24.04 / repository Node version.

### End-to-end throughput

| Effect cost | Workers | Distributed settlement | Single authority lane | Lane / distributed |
| ---: | ---: | ---: | ---: | ---: |
| 0 ms | 1 | 51.517/s | 57.588/s | 1.118x |
| 0 ms | 2 | 42.367/s | 47.843/s | 1.129x |
| 0 ms | 4 | 25.704/s | 30.673/s | 1.193x |
| 0 ms | 8 | 14.857/s | 17.304/s | 1.165x |
| 25 ms | 1 | 24.073/s | 25.878/s | 1.075x |
| 25 ms | 2 | 29.850/s | 33.231/s | 1.113x |
| 25 ms | 4 | 23.414/s | 30.033/s | 1.283x |
| 25 ms | 8 | 13.664/s | 16.992/s | 1.244x |
| 100 ms | 1 | 8.598/s | 8.753/s | 1.018x |
| 100 ms | 2 | 14.263/s | 14.515/s | 1.018x |
| 100 ms | 4 | 17.373/s | 18.724/s | 1.078x |
| 100 ms | 8 | 13.318/s | 16.060/s | 1.206x |

### Authority-lane scaling

At 100 ms effect cost the authority-lane speedup relative to one worker is:

| Workers | Speedup |
| ---: | ---: |
| 1 | 1.000x |
| 2 | 1.658x |
| 4 | **2.139x** |
| 8 | 1.835x |

The eight-worker regression is dominated by worker-process overhead in this harness. The measured effect-only phase is 3,457 ms / 2,007 ms / 1,516 ms / 1,794 ms at 1 / 2 / 4 / 8 workers respectively.

### Serialized authority cost

Across every worker count and effect-cost case, settling all 32 receipts through one production kernel took only about **89–107 ms total**. At 100 ms effect cost specifically:

| Workers | 32-receipt settlement |
| ---: | ---: |
| 1 | 92.330 ms |
| 2 | 89.269 ms |
| 4 | 89.833 ms |
| 8 | 95.370 ms |

Settlement cost therefore remains essentially independent of effect-worker count when authority mutation stays in one lane.

Workers in the authority-lane cases received packet bytes only. Exact `ExecutionPermit` values remained with the coordinator, which independently observed each local-file postcondition before settlement.

## Interpretation

The distinguishing criterion is satisfied.

Positive N-way speedup appears once effect cost is material, while exact authority can remain serialized and cheap. Competing multi-writer settlement is not required for useful parallelism.

The next production slice should therefore extend the existing core loop with bounded effect concurrency while retaining claim, effect reservation, observation, and settlement in one deterministic kernel lane. This is a smaller and safer change than distributed authority, receipt rebasing, or worker-owned settlement.
