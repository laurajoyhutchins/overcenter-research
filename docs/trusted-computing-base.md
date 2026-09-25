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

## Current baseline

The table below is generated from the executable report. Run `npm run update:tcb-doc` after an intentional ratchet change; `npm run check:tcb` fails if the checked-in block drifts from the measured policy.

<!-- BEGIN GENERATED TCB BASELINE -->
| Property | Explicit slice | Runtime symbols | Import envelope | Hybrid TCB | Hostile evidence | Hybrid SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `broker-mutation-safety` | 1,106 | 3,260 | 8,039 | **8,163** | current | `72f42dc9f555…f03e` |
| `no-false-done` | 1,523 | 3,101 | 8,039 | **8,160** | stale | `ccbbc8af3bab…c8de` |
| `github-commit-status-provider` | 2,377 | 2,550 | 2,740 | **2,746** | unconfigured | `6d7c785ce55b…30ba7` |

| Composition | Deduplicated hybrid union | Hostile evidence | Union SHA-256 |
| --- | ---: | --- | --- |
| `github-status-safe-settlement` | **8,348** | stale-and-incomplete | `470b5bbf1006…5707` |
<!-- END GENERATED TCB BASELINE -->

The property scopes overlap and must not be summed. The composed GitHub status path is the deduplicated end-to-end trust surface for mutation admission through authoritative settlement. The two core properties share most of the same broad authority, graph, observation, and provider cone; adding the GitHub commit-status profile increases the composed hybrid surface by only 185 semantic lines above broker mutation safety.

Hostile-evidence freshness is deliberately separate from the TCB size ratchet. A stale mutation probe remains visible as debt but does not make unrelated source changes fail the merge gate; an unknown configured probe still fails closed. `unconfigured` means the property does not yet have a dedicated hostile mutation probe.

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
