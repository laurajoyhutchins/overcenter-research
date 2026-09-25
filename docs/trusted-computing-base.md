# Trusted computing base

Overcenter measures safety complexity by **property-scoped trusted computing base (TCB)** rather than total repository size.

A TCB entry means: if this code is wrong in a relevant way, the named safety property may fail. Code outside that property's TCB is permitted to be buggy without invalidating the property, subject to the listed external assumptions.

The machine-readable policy is [`tcb-policy.json`](../tcb-policy.json). Reproduce the current report with:

```sh
npm run check:tcb
```

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

| Property | Explicit slice | Runtime symbols | Import envelope | Hybrid TCB | Hybrid SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| Broker mutation safety | 1,108 | 3,194 | 7,947 | **8,058** | `1e1c53ff04f6…ed1ed` |
| No false `DONE` | 1,501 | 3,035 | 7,947 | **8,055** | `401fbf9b746f…c3ddb` |
| GitHub commit-status provider | 2,377 | 2,550 | 2,740 | **2,746** | `4a2a068440cf…67d3e` |

The hybrid counts are property-scoped and overlap. Do not sum them into one repository number. The core properties explicitly bind the `DurableFactStore.append` dispatch edge to `SqliteFactStore.append`. The GitHub provider profile composes with broker mutation safety at `KernelCore.authorizeEffect`, `performEffect`, and `releaseEffectReservation`; those core methods are not charged again to the provider-specific delta. Six provider-profile lines beyond the import envelope remain deliberately charged: the effect authority's `postcondition` field and the five GitHub commit-status coordinates it consumes.

## Headline unions

The property-scoped numbers overlap heavily, so the report also computes deduplicated composites from the already-ratcheted hybrid line sets.

| Composite | Components | Deduplicated TCB | SHA-256 |
| --- | --- | ---: | --- |
| Project-truth safety | broker mutation safety + no false `DONE` | **8,059** | `44cdb15907a4…11119` |
| GitHub status end-to-end | project-truth safety + GitHub commit-status provider | **8,243** | `a340d94df028…7203c` |

The project-truth composite is the current repository answer to “what code must collectively be right for the headline safety property?” The GitHub end-to-end profile adds only 184 unique semantic LOC to that union. That small delta is partly an architectural warning: the current core runtime-import envelope already reaches substantial provider machinery through shared dispatch and observation paths. Treat provider code appearing in the core TCB as coupling pressure to remove, not as evidence that provider-specific semantics are free.

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
