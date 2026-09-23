# Execution witness recovery

## Question

Can a complete syscall-level execution witness safely discharge some post-reservation `RECOVERY_REQUIRED` cases without pretending to know whether a remote provider committed a request that already crossed the effect boundary?

## Claim and contrast

The bounded claim is that a trusted Linux supervisor can prove a reserved execution terminated before any request bytes were issued to the provider socket and may therefore classify that attempt as safe to retry. Once request bytes have been issued, the witness must remain ambiguous and defer to provider reconciliation.

The baseline treats every crash after durable reservation as potentially mutating. The unsafe negative control treats "no response observed" as evidence that no effect happened.

## Hostile cases

A fake provider owns an independent fsync-backed commit ledger. A ptrace supervisor kills the broker at four points:

1. before `connect(2)`;
2. after successful connect but before any request bytes are sent;
3. immediately after the request send syscall returns;
4. after a provider response has been read but before local settlement.

The classifier is replayed from the immutable trace. It may emit `safe-retry` only when the trace contains no successful effect-send syscall. The provider ledger is ground truth for whether the fake external effect committed.

Success requires:

- the conservative baseline releases zero cases;
- the witness safely releases at least the two pre-send crashes;
- witness false certainty remains exactly zero;
- the unsafe "no response" classifier produces at least one false certainty after a committed request;
- replaying classification from the same trace returns the same result.

## Run

```sh
npm run test:execution-witness
```

The hosted workflow also attempts an `rr` record/replay probe. The probe records a process that reads environment, filesystem, wall clock, and random inputs, mutates the live environment and file, then requires replay to reproduce the original output. If the hosted VM cannot expose the PMU or other kernel facility required by `rr`, that is recorded as a substrate limitation rather than being conflated with the ptrace recovery result.

## Result

GitHub Actions run `35820143252` evaluated exact revision `33911faa705d8be4aac8cfc92a9472f841706411`.

- conservative baseline safe retries: **0/4**
- execution-witness safe retries: **2/4**, both before any request bytes crossed the provider socket
- witness false-certainty cases against the independent provider ledger: **0**
- unsafe "no response means no effect" negative-control false-certainty cases: **1**
- after-send and after-response crashes both remained **ambiguous**, and the provider ledger recorded a commit in both cases

The separate hosted `rr` probe did not record a trace. Ubuntu's packaged `rr 5.7` first rejected the runner's newer Intel CPU identifier. A bounded compatible-microarchitecture override advanced past that check, but `perf_event_open` then reported that hardware performance counters were unavailable on the hosted VM. Full process record/replay therefore remains unevaluated on this substrate; that limitation is independent of the passing ptrace witness result.

## Interpretation and non-claims

This experiment tests whether Linux-level evidence can shrink Overcenter's conservative uncertainty interval. It does not make a network send proof of provider commit, does not authorize retry after request bytes cross the broker boundary, and does not make the ptrace format a production evidence certificate.

The fake provider is loopback and strongly deterministic. The trace classifier is deterministic replay of recorded syscall evidence, not full process replay. The separate `rr` probe tests captured-world replay feasibility on the hosted substrate but does not by itself establish a production record/replay design.
