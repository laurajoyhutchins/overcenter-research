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

## Hosted result

Exact evaluated revision: `f789fd6cbae0324756aac509482f9c1d6f6e9b5f`

GitHub Actions run: `35540486815` on Ubuntu 24.04 / Node 22.16.0.

The fairness counterexample reproduced exactly: eight consecutive scheduling decisions selected `a` while continuously READY `b` was never selected.

| Workers | Tasks/s | Speedup | Parallel efficiency | Contention retries |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 7.927 | 1.000x | 1.000 | 0 |
| 2 | 8.064 | 1.017x | 0.509 | 34 |
| 4 | 4.126 | 0.520x | 0.130 | 105 |
| 8 | 2.254 | 0.284x | 0.036 | 245 |

The current transaction path therefore does not demonstrate N-way scheduler scaling on this workload. Two workers provide essentially no throughput gain; additional workers invert scaling while authority contention rises sharply. This identifies the serialized authority/projection path as a real optimization target before distributed/HA machinery is justified.
