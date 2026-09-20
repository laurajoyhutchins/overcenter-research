# Production latency

## Question

For one successful external effect, how much wall-clock latency belongs to Overcenter itself versus the provider?

This experiment exercises the production SQLite authority path and the production GitHub commit-status effect. It measures one obligation per fresh initialized authority so historical mutable-realization readback does not contaminate the single-operation number.

```text
SQLite define / READY / claim
        |
        v
certified repository identity
        |
        v
durable effect reservation
        |
        v
GitHub status mutation
        |
        v
authoritative GitHub readback
        |
        v
SQLite verification / settlement
```

## Buckets

The benchmark records:

- **authority**: define, READY derivation, and exact claim;
- **provider identity**: certified GitHub repository identity read;
- **effect reservation**: durable kernel reservation before the mutation callback begins;
- **provider mutation**: the status POST;
- **readback**: provider reads used by settlement;
- **settlement local**: verification and durable receipt work after subtracting readback I/O;
- **Overcenter local total**: authority + reservation + adapter-local + settlement-local time;
- **provider total**: identity + mutation + readback;
- **end to end**: the complete successful transaction.

The adapter timing hook observes the existing production path; it does not create an alternate effect implementation.

## Reproduce

Deterministic local measurement:

```sh
npm run bench:production-latency
```

This uses the production SQLite kernel and effect adapter with an in-memory fake GitHub transport. It is useful for detecting local Overcenter overhead and regressions, not for estimating network latency.

The hosted workflow `.github/workflows/production-latency.yml` runs:

```sh
npm run bench:production-latency:live
```

against the real GitHub API at the exact workflow source revision.

## Success criteria

The benchmark is valid when every sample:

1. derives and claims one exact obligation through SQLite authority;
2. certifies repository identity;
3. durably reserves before mutation;
4. performs the declared status effect;
5. settles `DONE` only after authoritative readback;
6. reports non-overlapping timing buckets for provider and local work.

No fixed latency threshold is part of the correctness proof. Absolute timing is host-, network-, and provider-dependent.

## Result

See [`results/2026-09-20.md`](./results/2026-09-20.md). The first live run measured a 1.774 s median successful transaction, of which 9.481 ms was Overcenter-local and 1.765 s was provider I/O.

## Interpretation

This answers the bounded question, "What does one successful transaction cost?" It can show whether Overcenter local bookkeeping is material relative to provider I/O.

It deliberately does **not** answer:

- throughput under many concurrent workers;
- large-history projection cost;
- rate-limit ceilings;
- recovery-path latency after an uncertain mutation;
- distributed/HA SQLite behavior;
- latency for providers other than GitHub.
