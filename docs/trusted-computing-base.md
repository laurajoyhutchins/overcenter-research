# Trusted computing base

Overcenter measures safety complexity by **property-scoped trusted computing base (TCB)** rather than total repository size.

A TCB entry means: if this code is wrong in a relevant way, the named safety property may fail. Code outside that property's TCB is permitted to be buggy without invalidating the property, subject to the listed external assumptions.

The machine-readable policy is [`tcb-policy.json`](../tcb-policy.json). Reproduce the current report with:

```sh
npm run check:tcb
```

CI runs the same reporter on every evidence candidate and writes a compact analysis to the GitHub job summary: property and composition sizes, ratchet deltas, symbol-closure status, hostile-evidence freshness, and the largest files in each composed trust surface. The workflow also materializes the complete JSON report at `$RUNNER_TEMP/overcenter-tcb-report.json` for later steps without introducing a second analysis implementation.

The report gives every trusted slice an exact path, symbol or whole-file boundary, source-line range, semantic LOC count, and SHA-256 fingerprint. It then computes two independent dependency views: a transitive runtime-import envelope and a TypeScript-checker runtime-symbol closure. The import envelope is **not** an upper bound: hosted measurement falsified that assumption because injected runtime objects can call trusted code without importing its module. The ratcheted hybrid envelope therefore charges whole runtime-imported files plus runtime declarations reached across those non-import symbol edges.

## Properties

### Broker mutation safety

A broker-owned provider mutation must not cross the Overcenter effect boundary until current execution authority and exact claimed revision have been checked, an effect reservation has been durably appended, and no unresolved prior effect exists.

This property does **not** claim that an uncontrolled worker lacks ambient provider credentials. Physical effect confinement is a separate property with a different TCB.

### No false `DONE`

A run must not become `DONE` from worker assertion. `DONE` must arise from an admitted receipt whose authoritative observation proves the exact postcondition, with replay and historical realization reuse preserving those constraints.

### GitHub commit-status provider profile

The generic core depends on provider-specific facts being interpreted correctly. GitHub commit status therefore has a separately charged provider TCB covering repository identity, request dispatch certainty, response certification, pagination, and status-coordinate semantics.

## Budget rule

Each property has explicit-slice, import-envelope, and hybrid semantic-LOC ceilings. CI also requires the symbol closure to have zero unresolved runtime-dispatch obligations. The hybrid SHA-256 fingerprint covers the import-envelope fingerprint, cross-envelope trusted declaration slices, runtime dispatch bindings, and property-composition cuts, so a same-LOC trust-edge change still requires an explicit policy update.

A LOC ceiling or static dependency closure is not a proof. It is an architectural ratchet. The stronger evidence comes from combining this inventory with hostile tests, authority-flow analysis, exact-head CI, differential backends, and formal models.

Hard ratchets and attention baselines are intentionally different. Hard ratchets fence the exact trusted surface admitted by the current revision. Attention baselines preserve the architectural target across intentional ratchet updates. If the measured TCB grows above an attention baseline, updating the hard fingerprint does not erase the debt: the reporter derives a stable `tcb-growth` obligation until the trusted surface is reduced or the attention baseline is deliberately changed.

## Current baseline

The table below and `.overcenter/tcb-obligations.json` are generated from the executable report. Run `npm run update:tcb` after an intentional ratchet change; `npm run check:tcb` fails if either generated artifact drifts from the measured policy.

<!-- BEGIN GENERATED TCB BASELINE -->
| Property | Explicit slice | Runtime symbols | Import envelope | Hybrid TCB | Hostile evidence | Hybrid SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `broker-mutation-safety` | 1,106 | 3,261 | 8,039 | **8,163** | current | `72f42dc9f555…8f03e` |
| `no-false-done` | 1,523 | 3,102 | 8,039 | **8,160** | stale | `ccbbc8af3bab…2c8de` |
| `github-commit-status-provider` | 2,377 | 2,550 | 2,740 | **2,746** | unconfigured | `6d7c785ce55b…30ba7` |

| Composition | Deduplicated hybrid union | Hostile evidence | Union SHA-256 |
| --- | ---: | --- | --- |
| `github-status-safe-settlement` | **8,348** | stale-and-incomplete | `470b5bbf1006…95707` |
<!-- END GENERATED TCB BASELINE -->

The property scopes overlap and must not be summed. The composed GitHub status path is the deduplicated end-to-end trust surface for mutation admission through authoritative settlement. The two core properties share most of the same broad authority, graph, observation, and provider cone; adding the GitHub commit-status profile increases the composed hybrid surface by only 185 semantic lines above broker mutation safety.

Hostile-evidence freshness is deliberately separate from the TCB size ratchet. A stale mutation probe remains visible as debt but does not make unrelated source changes fail the merge gate; an unknown configured probe still fails closed. `unconfigured` means the property does not yet have a dedicated hostile mutation probe.

## Derived obligations

The reporter deterministically projects actionable TCB findings into `.overcenter/tcb-obligations.json`. Current finding classes are TCB growth above an attention baseline, stale or missing hostile evidence, newly introduced external assumptions, and excessive trusted-file concentration.

The TCB manifest is an ordinary managed project-graph producer. `project.advance` reconciles only its `tcb:` namespace when that exact-source manifest is present. A finding that disappears from the executable analysis is retired; unrelated project obligations remain ensure-only and are never retired by this mechanism.

These findings are **judgment work**, not executable effect packets. They use the `operator-judgment/v1` postcondition, project as `BLOCKED` with `JUDGMENT_REQUIRED`, and automatic observation rejects them. The deterministic layer therefore decides that evidence requires attention and preserves the evidence; a reasoning agent or operator decides what source change, if any, is the right remedy.

The core properties explicitly bind the `DurableFactStore.append` dispatch edge to `SqliteFactStore.append`. The GitHub provider profile composes with broker mutation safety at `KernelCore.authorizeEffect`, `performEffect`, and `releaseEffectReservation`; those core methods are not charged again to the provider-specific delta.

## External assumptions

External assumptions are part of the TCB even though they have no repository LOC. The report keeps them visible instead of allowing a small source-code number to imply that SQLite, Node.js, the operating system, TLS, the system `curl` executable used by GitHub certified reads, or provider API semantics are somehow irrelevant. The report also lists external runtime modules and symbols reached by the analysis; those lists are dependency evidence, not repository LOC.

## Direction

Prefer changes that:

1. remove trusted symbols or whole-file entries;
2. replace whole-file entries with mechanically justified symbol slices;
3. eliminate external assumptions;
4. move fallible orchestration and reasoning outside the TCB; and
5. preserve or strengthen the safety property while shrinking the trusted surface.

The target is not the smallest repository. It is the smallest piece of software that must be right.
