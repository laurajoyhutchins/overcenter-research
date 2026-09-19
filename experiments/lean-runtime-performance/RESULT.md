# Result: Lean live-runtime performance

## Exact evidence

Experiment head:

`be2ba06c4d9cc628af2f2455a648709009b44c82`

GitHub Actions run:

`35460522089`

Runner:

- Ubuntu 24.04
- Node 22.16
- Lean 4.34.0
- exact-head checkout asserted before execution

All build, smoke, correctness, and benchmark steps completed successfully.

## Frozen gate result

The precommitted 1,000-obligation production gate was:

- correctness parity;
- Lean one-shot p95 <= 50 ms;
- Lean persistent p95 <= 20 ms;
- Lean one-shot maximum RSS <= 128 MiB.

Observed:

| Gate | Result |
| --- | ---: |
| correctness parity | PASS |
| one-shot p95 <= 50 ms | **FAIL: 56.679 ms** |
| persistent p95 <= 20 ms | PASS: 12.764 ms |
| one-shot RSS <= 128 MiB | PASS: 68,492 KiB |

Therefore the precommitted overall result is:

**CURRENT ONE-SHOT LEAN CLAIM-ADMISSION RUNTIME IS NOT YET PRODUCTION-JUSTIFIED BY THIS EXPERIMENT.**

Do not weaken the threshold after observing the result.

## Measurements

| Obligations | TypeScript p95 | Lean one-shot p95 | Lean persistent p95 | one-shot max RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.068 ms | 44.971 ms | 0.126 ms | 68,524 KiB |
| 10 | 0.026 ms | 43.964 ms | 0.129 ms | 68,820 KiB |
| 100 | 0.350 ms | 44.285 ms | 0.455 ms | 68,648 KiB |
| 1,000 | 1.528 ms | **56.679 ms** | **12.764 ms** | 68,492 KiB |
| 10,000 | 19.630 ms | 868.553 ms | 812.424 ms | 83,016 KiB |

At small sizes the one-shot executable has an approximately 35–45 ms fixed process-startup floor. The persistent executable removes that cost almost entirely.

At 1,000 obligations the underlying persistent semantic calculation remains within the frozen 20 ms gate.

At 10,000 obligations, however, removing process startup no longer helps materially: persistent p95 is 812.424 ms versus one-shot p95 868.553 ms. This demonstrates a semantic-kernel scaling problem rather than a packaging problem.

## Why the 10,000-obligation case bends upward

The current Lean implementation uses lists for global context validation.

In particular:

- `uniqueStrings` recursively calls `List.contains`, producing quadratic duplicate checking;
- `claimLifecycleCoverage` scans the lifecycle list for every obligation, also quadratic;
- `findClaimObligation` and `findClaimLifecycle` are linear list searches and can amplify graph/effect operations.

The observed persistent latency is consistent with that structure:

- 100 obligations: 0.423 ms median
- 1,000 obligations: 10.654 ms median
- 10,000 obligations: 808.879 ms median

The experiment does not prove an exact asymptotic exponent, but it decisively falsifies the assumption that the present list-based kernel scales acceptably to a 10,000-obligation context.

## Production interpretation

The evidence supports three distinct claims:

1. **Lean computation itself is fast enough at ordinary control-plane sizes.** The persistent kernel's 1,000-obligation p95 is 12.764 ms.
2. **The strongest one-process-per-decision boundary misses the frozen 50 ms p95 gate at 1,000 obligations.** It is close, but the experiment says fail.
3. **The current list-based semantic representation must not be used unbounded.** At 10,000 obligations it is hundreds of milliseconds slower than the TypeScript control and is dominated by semantic computation rather than process startup.

A live deployment can become justifiable by either:

- keeping a persistent isolated Lean process and enforcing a hard bounded semantic-context size while the representation is improved; or
- replacing repeated list scans with indexed / linear-time validation while preserving the same proof-bearing semantics, then rerunning this exact frozen benchmark.

The second path is preferable because it preserves the option of returning to the simpler one-shot process boundary.
