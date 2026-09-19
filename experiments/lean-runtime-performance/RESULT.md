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


---

## Indexed-validation optimization

The failed baseline identified repeated list scans in context validation as the dominant scaling defect. The repair changed only mechanically set-like operations:

- duplicate obligation and lifecycle detection now use `Std.HashSet.containsThenInsert`;
- known obligation-ID membership now uses a pre-sized `Std.HashSet`;
- lifecycle coverage now uses a pre-sized `Std.HashSet`.

Graph reachability, effect ordering, serialized protocol semantics, claim-admission theorem statements, and the frozen benchmark thresholds were not changed.

Because `HashSet` operations do not reduce transparently enough for the old concrete `by decide` examples, those examples now use `native_decide`. The generic implication theorems remain ordinary proofs and do not depend on those native-evaluated examples.

Additional hostile checks were added for:

- duplicate obligation IDs;
- duplicate lifecycle IDs;
- missing lifecycle coverage;
- unknown dependencies;
- dependency cycles.

The original Lean-vs-TypeScript hostile differential suite also runs before every performance measurement.

### Exact optimized evidence

Optimized exact head:

`82d7258a71d27a557346f43feef02751cc0d6af2`

GitHub Actions run:

`35462096820`

The same exact SHA was executed three times. All three attempts passed build, proof compilation, persistent-protocol smoke, indexed fail-closed checks, the original TypeScript differential hostile suite, and the unchanged benchmark.

### Frozen 1,000-obligation gate across exact-SHA attempts

| Attempt | TypeScript p95 | Lean one-shot p95 | Lean persistent p95 | one-shot max RSS | Overall |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1.490 ms | **48.468 ms** | **3.292 ms** | 69,172 KiB | PASS |
| 2 | 1.318 ms | **43.863 ms** | **2.338 ms** | 68,444 KiB | PASS |
| 3 | 1.727 ms | **48.517 ms** | **2.941 ms** | 68,612 KiB | PASS |

Every observed one-shot p95 is below the precommitted 50 ms ceiling. Every persistent p95 is far below the precommitted 20 ms ceiling. RSS remains far below 128 MiB.

### Stress result

The 10,000-obligation stress case changed from:

- baseline persistent p95: **812.424 ms**
- baseline one-shot p95: **868.553 ms**

to the following exact-SHA attempts:

| Attempt | TypeScript p95 | Lean one-shot p95 | Lean persistent p95 |
| ---: | ---: | ---: | ---: |
| 1 | 18.514 ms | 74.955 ms | 33.215 ms |
| 2 | 15.514 ms | 65.245 ms | 24.859 ms |
| 3 | 20.156 ms | 69.764 ms | 31.362 ms |

The optimized persistent kernel is approximately 24–33 ms p95 at 10,000 obligations instead of ~812 ms. The curve is now consistent with roughly linear growth over the measured 1,000 → 10,000 range rather than the prior quadratic-looking blow-up.

### Before / after

At 1,000 obligations:

- one-shot p95: **56.679 ms → 43.863–48.517 ms**
- persistent p95: **12.764 ms → 2.338–3.292 ms**

At 10,000 obligations:

- one-shot p95: **868.553 ms → 65.245–74.955 ms**
- persistent p95: **812.424 ms → 24.859–33.215 ms**

The stress improvement is too large to attribute to process-start jitter. It confirms the original diagnosis: repeated list membership scans, not Lean's compiled runtime, caused the pathological scaling.

## Final runtime conclusion

For the bounded claim-admission semantic role measured here:

**LEAN RUNTIME PERFORMANCE IS PRODUCTION-JUSTIFIED BY THE PRECOMMITTED EXPERIMENT.**

This conclusion is intentionally narrow.

It justifies a compiled Lean truth-deciding kernel behind a narrow normalized-facts boundary. It does not justify moving persistence, provider transport, mutation authority, scheduling, credentials, or the general Overcenter runtime into Lean.

The strongest and simplest measured deployment shape, one fresh Lean process per decision, now passes the frozen production gate on three exact-SHA attempts. A persistent isolated process remains available if lower latency is operationally valuable, but performance no longer forces that additional lifecycle machinery.

This branch is an experimental Lean lineage and is not current `main`. Production integration must therefore port the earned semantic slice into current architecture rather than merge this divergent branch wholesale.


---

## Self-review correction: production conclusion narrowed

A subsequent adversarial topology benchmark falsified the broad final conclusion above.

The original performance fixture contains **no dependency edges and no effects**. It therefore measures:

- protocol parsing / serialization;
- ID uniqueness;
- known-ID membership;
- lifecycle coverage;
- target lookup;
- flat no-dependency admission.

It does **not** exercise the expensive graph-reachability path in `claimGraphAcyclic` or ordered-effect reachability.

Exact follow-up head:

`8f847b91a0c886136ea7e95a9cb97940d34c901f`

GitHub Actions run:

`35462674255`

The follow-up used a valid linear dependency chain, with every upstream obligation DONE and the final target UNREALIZED.

| Chain obligations | TypeScript | Lean persistent | Lean one-shot |
| ---: | ---: | ---: | ---: |
| 25 | 0.259 ms | 0.479 ms | 35.649 ms |
| 50 | 0.288 ms | 0.948 ms | 42.297 ms |
| 100 | 0.737 ms | 1.860 ms | 40.411 ms |
| 200 | 1.165 ms | 9.504 ms | 46.010 ms |
| 400 | 1.634 ms | **69.481 ms** | **104.843 ms** |

(The first 10-node sample included process/server warm-up and is not useful for scaling interpretation.)

This is decisive counterevidence to the statement that claim-admission runtime, as a whole, is production-justified. The HashSet repair fixed the flat-context quadratic work, but the current reachability implementation still repeatedly calls `findClaimObligation` over a list while re-traversing ancestry for many edges. A chain therefore bends upward sharply.

### Corrected conclusion

The evidence currently supports:

**Lean's compiled runtime and the optimized flat-context validation are operationally cheap enough for the bounded semantic-kernel role. The current claim-admission graph algorithm is not yet production-justified for nontrivial dependency topology.**

The earlier sentence claiming that the complete bounded claim-admission runtime is production-justified is superseded by this correction.

Before a production port, graph validation/reachability should be indexed and/or replaced by a linear-time DAG algorithm, then benchmarked on at least:

- long chains;
- wide fan-in / fan-out;
- layered DAGs;
- dense but valid DAGs;
- ordered and unordered effect conflicts.

The flat fixture must remain as a regression, but it is not a sufficient production workload.

## Proof-strength correction

The generic theorems in `AdmissionProofs.lean` establish implications such as:

`claimAdmissible ctx = true -> claimContextWellFormed ctx = true`

and analogous implications for exact revision, target lifecycle, dependency completion, semantic inputs, and effect conflict.

These are useful fail-closed decomposition properties, but most follow directly from the conjunction structure of `claimAdmissible`. They do **not** by themselves prove that executable predicates such as `claimGraphAcyclic` are sound and complete decision procedures for an independently defined mathematical graph property.

Production-strength formalization should define the intended propositions independently and prove the executable decision procedures sound (and, where useful, complete) with respect to those propositions.

The HashSet optimization also lacks an explicit theorem showing extensional equivalence to the prior list-based uniqueness / membership definitions. Differential hostile tests provide regression evidence, not universal equivalence.

## Benchmark-method correction

Three additional limits should be retained in the record:

1. The 1,000-obligation p95 gate currently uses 20 observations per run. Three exact-SHA repetitions improve confidence but are still weak tail-latency statistics. A production benchmark should use materially more samples at the gate.
2. The 10,000-obligation stress case uses five observations, so its reported p95 is effectively the maximum of a tiny sample and should be read as stress evidence, not a stable percentile estimate.
3. The TypeScript comparator is not a perfectly identical computational slice: it includes current TypeScript admission validation plus `obligationKey` construction, while the Lean protocol decides normalized claim admission. Absolute Lean latency gates remain useful; direct TypeScript/Lean ratios should not be treated as a clean language benchmark.

No concurrency/load test, target-deployment-environment benchmark, or production-port benchmark has yet been performed.
