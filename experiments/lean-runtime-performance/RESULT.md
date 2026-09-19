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


---

## Final topology repair and proof-backed indexed kernel

The self-review correction above triggered a second optimization round. The frozen
latency thresholds were not changed.

The repair proceeded adversary by adversary rather than assuming that the first
indexing change generalized.

### 1. Graph acyclicity

The repeated per-edge reachability check was replaced with an indexed Kahn-style
topological traversal.

Kahn's result is not trusted directly. It produces a candidate topological order,
and an independent certificate checker verifies that:

- every obligation is covered;
- every dependency occurs earlier than its consumer.

The proposition-level specification is independent of Kahn's implementation.
The compiled theorem:

`claimGraphAcyclic_sound`

establishes that an accepted executable acyclicity decision implies the existence
of an independently defined topological ordering.

The obligation hash index is also tied back to the original list lookup by the
compiled theorem:

`claimObligationIndex_lookup_eq_find`

so the optimized lookup is not a second semantic authority.

The original 400-node chain counterexample changed from:

- persistent: **69.481 ms**
- one-shot: **104.843 ms**

to low-single-digit persistent latency and roughly process-startup-bounded
one-shot latency.

### 2. Wide dependency fan-in

A 10,000-obligation fixture in which the target directly depends on every other
obligation exposed another quadratic path: each dependency status was resolved
by a fresh linear lifecycle-list lookup.

The optimized path builds a first-occurrence-preserving lifecycle hash index.
Two compiled theorems bind it to the original semantics:

- `claimLifecycleIndex_lookup_eq_find`
- `claimDependenciesDone_eq_reference`

Before:

| Obligations | persistent |
| ---: | ---: |
| 2,000 | 22.219 ms |
| 5,000 | 103.305 ms |
| 10,000 | **367.163 ms** |

After the proved index substitution, a representative exact-head run measured:

| Obligations | persistent |
| ---: | ---: |
| 2,000 | 9.944 ms |
| 5,000 | 25.129 ms |
| 10,000 | **53.087 ms** |

A later final-head run measured 54.462 ms at 10,000. The resulting curve is
consistent with approximately linear growth over this range.

### 3. Ordered effect reachability

The retained implementation asked a fresh reachability question for every
conflicting effect. A long ordered effect chain exposed the resulting quadratic
tail:

| Obligations | reference-style persistent |
| ---: | ---: |
| 1,000 | 22.069 ms |
| 2,000 | 83.569 ms |
| 5,000 | 505.160 ms |
| 10,000 | **1,973.769 ms** |

The optimized implementation reuses the graph's topological order:

1. one forward pass marks obligations that depend on the target;
2. one reverse pass marks obligations on which the target depends;
3. each effect comparison becomes two hash-set membership checks.

The repeated-search implementation remains in the source as
`claimUnorderedEffectConflictReference`.

Unlike the obligation and lifecycle indexes, this optimized effect classifier
does **not yet have a universal equivalence theorem** to the retained reference.
Its current evidence is differential.

### Exhaustive small-DAG differential

A test-only comparison executable reuses the exact production parser but does
not add another production command.

CI exhausts:

- all **1,024** DAGs compatible with a fixed five-node topological labeling;
- every target / competing-effect ordered pair (**20** per DAG);
- forward and reverse obligation-list order;
- dependency-completion reference parity alongside effect-order parity.

That is **40,960** exact optimized-vs-reference comparisons per CI attempt.

Final exact head:

`3e438674551a6df487821e124f64e86bf30ebf06`

GitHub Actions run:

`35464387969`

All three attempts on this exact SHA passed the complete 40,960-case
differential gate.

This is strong bounded regression evidence, but it is deliberately not described
as a universal proof.

### Final ordered-effect stress

Across the three exact-SHA attempts:

| Obligations | Attempt 1 persistent | Attempt 2 persistent | Attempt 3 persistent |
| ---: | ---: | ---: | ---: |
| 1,000 | 9.158 ms | 9.274 ms | 9.286 ms |
| 2,000 | 18.244 ms | 19.063 ms | 18.526 ms |
| 5,000 | 43.039 ms | 42.878 ms | 43.350 ms |
| 10,000 | **91.721 ms** | **90.884 ms** | **94.028 ms** |

The previous 10,000-node result was 1,973.769 ms persistent. The optimized
classification therefore removes the observed quadratic effect-order tail over
the measured range.

### Final frozen production gate

The final algorithmic shape was executed three times on the same exact SHA.

| Attempt | TypeScript p95 | Lean one-shot p95 | Lean persistent p95 | one-shot max RSS | Gate |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1.673 ms | **49.191 ms** | **3.735 ms** | 68,892 KiB | PASS |
| 2 | 1.582 ms | **46.442 ms** | **3.717 ms** | 68,796 KiB | PASS |
| 3 | 1.734 ms | **49.347 ms** | **3.579 ms** | 68,856 KiB | PASS |

All three final-head attempts pass every frozen criterion:

- correctness parity: PASS;
- one-shot 1,000-obligation p95 <= 50 ms: PASS;
- persistent 1,000-obligation p95 <= 20 ms: PASS;
- one-shot maximum RSS <= 128 MiB: PASS.

The one-shot margin is intentionally reported as narrow. Two of the three p95
measurements are within one millisecond of the precommitted ceiling. The
persistent shape has much larger latency margin.

The 10,000-obligation flat stress case on these attempts remained approximately
37–40 ms persistent. That case still has only five observations per run and
should be interpreted as stress evidence, not a statistically stable p95.

## Final corrected conclusion

The earlier self-review correction is now itself superseded for the measured
experimental kernel.

The evidence supports:

**The compiled Lean claim-admission kernel now satisfies the frozen runtime gate
on three final exact-SHA attempts and no longer shows pathological scaling on the
measured chain, fan-in, fan-out, layered, dense, or ordered-effect adversaries.**

The strongest correctness evidence is not uniform across every predicate:

- graph-acyclic acceptance has an independent proposition-level soundness proof;
- optimized obligation lookup is proved equal to the original list lookup;
- optimized lifecycle lookup and dependency completion are proved equal to their
  retained list-based reference semantics;
- optimized effect ordering has 40,960 exhaustive small-DAG differential
  comparisons plus large stress fixtures, but not yet a universal equivalence
  theorem to the retained reference.

Therefore this experiment justifies the **runtime and algorithmic viability** of
Lean for the bounded claim-admission truth-deciding role. It does not by itself
justify a production merge into current `main`.

Remaining production-integration evidence is separate:

- port the earned semantic slice onto current architecture rather than merging
  this divergent experimental lineage wholesale;
- preserve exact normalized-input and authority boundaries;
- rerun the proof/differential/performance suite on the ported revision;
- measure the actual deployment substrate and concurrency/load behavior;
- if formal assurance for effect ordering is required at the same level as graph
  acyclicity, add a universal soundness/equivalence theorem rather than treating
  bounded exhaustive differential evidence as proof.
