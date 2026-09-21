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
