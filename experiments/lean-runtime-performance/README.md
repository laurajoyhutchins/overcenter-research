# Lean live-runtime performance experiment

## Question

Can the already-earned Lean claim-admission semantic kernel run in a live Overcenter control-plane path without an operationally significant latency or memory penalty?

This experiment does **not** ask whether Lean should become the general Overcenter runtime. It benchmarks only the bounded truth-deciding claim-admission role already justified by the differential proof experiment.

## Exact authority

The experiment branch starts from Lean integration head:

`c0a3cf6e54519b45ebf9b7cc9bad93c97b3a3a5a`

The branch is intentionally not rebased onto current `main`: those histories have diverged substantially. This isolates the runtime claim for the actual Lean semantic kernel without pretending unrelated later production work is part of the measurement.

## Compared execution shapes

1. **TypeScript in-process**: the existing production control path composed from `validateAdmission()`, `claimabilityError()`, and `obligationKey()`.
2. **Lean one-shot**: the current stdin/stdout executable, spawned once per decision.
3. **Lean persistent**: the same `AdmissionProtocol.handle` semantics behind a line-delimited stdin/stdout process, removing per-decision process startup while adding no database, daemon authority, provider credentials, or mutable semantic state.

The persistent executable exists only to distinguish process-spawn cost from semantic computation cost. It does not change the authority boundary.

## Input sizes

The benchmark uses independent file-content obligations with no effect semantics and an unrealized target:

- 1
- 10
- 100
- 1,000
- 10,000 obligations

Fixture construction and JSON construction are outside the timed region. The 1,000-obligation case is the precommitted production gate. The 10,000-obligation case is stress evidence, not a production admission requirement.

## Measurements

For every size:

- p50 / p95 / p99 / max / mean decision latency;
- serialized request bytes;
- Lean one-shot maximum RSS via `/usr/bin/time`;
- persistent Lean RSS and high-water RSS from `/proc`;
- correctness: every implementation must return the same admitted decision.

Repetition counts decrease with size so the experiment remains bounded while retaining useful tail samples.

## Precommitted production gate

At 1,000 obligations:

- correctness parity must hold;
- one-shot Lean p95 must be <= 50 ms;
- persistent Lean p95 must be <= 20 ms;
- one-shot Lean maximum RSS must be <= 128 MiB.

The one-shot threshold is the primary live-production test because it preserves the strongest boring process-isolation boundary. Persistent performance is diagnostic and demonstrates whether failure, if any, is spawn overhead or semantic computation.

A failed gate is useful evidence. Do not weaken thresholds after observing the result.
