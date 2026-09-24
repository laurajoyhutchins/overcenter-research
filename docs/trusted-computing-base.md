# Trusted computing base

Overcenter measures safety complexity by **property-scoped trusted computing base (TCB)** rather than total repository size.

A TCB entry means: if this code is wrong in a relevant way, the named safety property may fail. Code outside that property's TCB is permitted to be buggy without invalidating the property, subject to the listed external assumptions.

The machine-readable policy is [`tcb-policy.json`](../tcb-policy.json). Reproduce the current report with:

```sh
npm run check:tcb
```

The report gives every trusted slice an exact path, symbol or whole-file boundary, source-line range, semantic LOC count, and SHA-256 fingerprint. It also computes a conservative transitive repository-module closure from every trusted root. The explicit slice is a lower bound; the module closure is an upper bound until symbol-level dependency closure can mechanically narrow the gap. Whole-file entries are intentionally conservative where the current analysis cannot yet prove a smaller sound slice.

## Properties

### Broker mutation safety

A broker-owned provider mutation must not cross the Overcenter effect boundary until current execution authority and exact claimed revision have been checked, an effect reservation has been durably appended, and no unresolved prior effect exists.

This property does **not** claim that an uncontrolled worker lacks ambient provider credentials. Physical effect confinement is a separate property with a different TCB.

### No false `DONE`

A run must not become `DONE` from worker assertion. `DONE` must arise from an admitted receipt whose authoritative observation proves the exact postcondition, with replay and historical realization reuse preserving those constraints.

### GitHub commit-status provider profile

The generic core depends on provider-specific facts being interpreted correctly. GitHub commit status therefore has a separately charged provider TCB covering repository identity, request dispatch certainty, response certification, pagination, and status-coordinate semantics.

## Budget rule

Each property has an explicit semantic-LOC ceiling. CI fails if the counted trusted slice exceeds it. The baseline is ratcheted to the exact hosted measurement, so future TCB growth requires an explicit policy change. A whole-surface SHA-256 fingerprint also makes same-LOC trusted-code edits visible once the baseline fingerprint is recorded.

A LOC ceiling is not a proof. It is an architectural ratchet. The stronger evidence comes from combining this inventory with hostile tests, authority-flow analysis, exact-head CI, differential backends, and formal models.

## Current baseline

| Property | Explicit slice LOC | Conservative module closure LOC | Closure SHA-256 |
| --- | ---: | ---: | --- |
| Broker mutation safety | 1,108 | 7,947 | `d52fd14cf1ca…5df87` |
| No false `DONE` | 1,501 | 7,947 | `d52fd14cf1ca…5df87` |
| GitHub commit-status provider | 2,377 | 2,740 | `8f572e9d658f…e00a3` |

These scopes overlap and must not be summed into a repository-wide figure without deduplicating shared code. The two core properties currently share the same 7,947-LOC closure because their trusted roots eventually reach the same broad authority, graph, observation, and provider module cone. That is useful pressure: the 6,839-LOC and 6,446-LOC gaps are uncertainty to remove, not evidence that every line in the closure is actually security-critical. The GitHub provider gap is much narrower at 363 LOC.

## External assumptions

External assumptions are part of the TCB even though they have no repository LOC. The report keeps them visible instead of allowing a small source-code number to imply that SQLite, Node.js, the operating system, TLS, the system `curl` executable used by GitHub certified reads, or provider API semantics are somehow irrelevant. The report also lists every external module reached by the conservative closure; that list is an over-approximation and is not itself a claim that every imported module is necessary to the named property.

## Direction

Prefer changes that:

1. remove trusted symbols or whole-file entries;
2. replace whole-file entries with mechanically justified symbol slices;
3. eliminate external assumptions;
4. move fallible orchestration and reasoning outside the TCB; and
5. preserve or strengthen the safety property while shrinking the trusted surface.

The target is not the smallest repository. It is the smallest piece of software that must be right.
