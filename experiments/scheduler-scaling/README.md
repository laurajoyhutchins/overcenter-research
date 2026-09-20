# Scheduler fairness and scaling

## Question

Does the current production SQLite scheduler provide fairness and useful N-way end-to-end scaling, rather than only concurrent physical execution?

## Design

The experiment uses the production `OvercenterKernel` unchanged.

1. A deterministic hostile witness keeps obligations `a` and `b` continuously READY while repeatedly selecting and releasing `a`. If the current first-ready policy is unfair, `b` remains READY but is never selected.
2. A multi-process load harness creates 32 independent obligations and runs the same workload with 1, 2, 4, and 8 worker processes against one production SQLite authority file.
3. Each worker performs the real sequence: derive READY work, exact-revision claim, materialize a local-file postcondition, independently observe it, and settle DONE.
4. Setup/definition time is excluded. The measured interval is claim-through-settlement scheduling work only.

The benchmark records throughput, CAS/SQLite retry pressure, idle polls, speedup, and parallel efficiency.

## Interpretation

A green experiment means the harness preserved safety and produced valid evidence. It does **not** mean scaling was good.

The fairness witness is intentionally a counterexample test: while production uses lexicographically first READY selection, success means starvation is reproducible. If a future scheduler fixes fairness, this witness should fail and be replaced by the corresponding liveness proof.

For scaling, the output is empirical and host-dependent. Useful N-way scaling would appear as materially increasing throughput as worker count rises. Flattening or regression identifies the serialized authority/projection path as the limiting boundary; it does not by itself justify distributed authority.

## Reproduce

```sh
npm run experiment:scheduler-scaling
```

The hosted workflow runs on Ubuntu with the exact repository Node version and a three-minute ceiling.

## Non-claims

- This is not a proof of distributed SQLite or HA.
- It does not establish a portable throughput constant.
- It does not prove fairness after any scheduler repair.
- It does not justify sharding, replication, or consensus without a measured bottleneck.
