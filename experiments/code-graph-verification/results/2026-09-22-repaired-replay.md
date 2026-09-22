# Repaired frontier calibration replay — 2026-09-22

The deterministic representation repaired from the v1 falsification clears all of the **same frozen gates** when replayed against the preserved Flask oracle outcomes:

| Metric | Frozen gate | Repaired replay |
| --- | ---: | ---: |
| Affected-test recall | >= 0.99 | **1.000000** |
| Selected fraction | <= 0.30 | **0.231072** |
| Missed regressions | 0 | **0** |
| Precision | report only | 0.241793 |
| Verification reduction | report only | 0.768928 |

That is 383 / 383 affected outcomes caught, 0 missed regressions, and 1,584 selected outcomes out of a 6,855-outcome verification universe.

## What changed

The repaired graph adds only deterministic relations exposed by v1:

- decorator-aware changed-symbol spans;
- qualified and import-aware call resolution;
- exact package re-export resolution;
- explicit Click command registration and literal dispatch edges;
- patched-code syntax checking with import/conftest blast-radius expansion; and
- a bounded fallback for unresolved attribute calls only when the attribute name has at most three internal definitions.

The last rule is an explicit uncertainty budget. It does not restore v1's unbounded simple-name fanout.

## Evidence coordinates

No test suite was rerun for this final calibration step. The oracle JUnit outcomes from run `35739887949` were reused unchanged.

Frontier replay and rescoring ran as `35741538548`, job `106792274322`. Summary artifact `10699658915` has SHA-256 `fc0a62ca98a922c2be97d8a3a223ede9ba48d355b6ad32bdbdc39401dbc96e17`.

The evaluated graph base revision is `b1e726bca0210536285ab3fcd081160167bb9165`; the one-shot workflow revision is `86f12c3a4aa3afa673edf1b8dbbff8af78390e15`.

## Boundary

This is **post-hoc calibration, not independent confirmation**. The graph changes were chosen after inspecting failures from this same Flask corpus. Passing the frozen gates now shows that the observed ambiguity was mechanically representable; it does not establish generalization to unseen codebases or unseen change distributions.

The next falsification should therefore use a fresh holdout without changing this representation first.
