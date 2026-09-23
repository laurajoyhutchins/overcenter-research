# Distributed authority chaos

## Question

Does the Postgres-free remote-CAS authority architecture survive repeated controller turnover and unrelated concurrent authority updates, rather than only the staged handoff proved by `distributed-authority-handoff`?

## Why this follows the handoff experiment

The first experiment established one real multi-runner path:

```text
same READY revision
      ↓
one remote-CAS claim winner
      ↓
fresh controller
      ↓
effect reservation + live GitHub mutation
      ↓
fresh recovery controller
      ↓
DONE
```

That is strong safety evidence but weak endurance evidence. This experiment deliberately does **not** repeat the provider-general mutation claim. It isolates the authority/recovery machinery and tries to make controller continuity irrelevant over many transitions.

## Preregistered treatment

The hosted treatment defines 48 independent obligations and partitions them by stable owner across eight logical controllers:

```text
controller 0: 0, 8, 16, ...
controller 1: 1, 9, 17, ...
...
controller 7: 7, 15, 23, ...
```

All eight controllers still mutate one remote authority head, so unrelated claims, execution rotations, reservations, interruption receipts, and settlements contend through the same exact-head CAS coordinate.

Three GitHub Actions matrix waves are run. Every wave receives a fresh checkout and therefore no predecessor process memory, cache, or application database.

Each obligation has one of six deterministic modes:

| mode | first controller | recovery controller |
| --- | --- | --- |
| 0 | claim → observe → DONE | none |
| 1 | claim → reserve → observe → DONE | none |
| 2 | claim → terminate | acquire generation 2 → recover → DONE |
| 3 | claim → reserve → terminate | acquire generation 2 → prove replay blocked → recover → DONE |
| 4 | claim → terminate | acquire generation 2 → terminate again; later generation 3 recovers |
| 5 | claim → reserve → terminate | acquire generation 2 → terminate again; later generation 3 proves replay blocked and recovers |

After three injected-failure waves, one entirely fresh sweeper may take at most 256 successful authority transitions to drive the remaining project to all-DONE.

## Observation fixture

The postcondition is a stable local-file observation recreated independently in each fresh controller environment. It is intentionally boring.

That choice keeps the experiment about authority continuity:

```text
controller continuity      under test
remote CAS contention      under test
execution fencing          under test
reservation persistence    under test
fresh-controller recovery  under test

provider mutation generality   not under test
```

The previous distributed-authority-handoff experiment already crossed the production GitHub status mutation path.

## Acceptance criteria

The treatment is supported only if:

1. all 48 obligations end `DONE`;
2. every obligation has exactly one durable claim;
3. no run has more than one effect reservation;
4. `chaos-0003` and `chaos-0005` retain exactly one reservation through recovery;
5. `chaos-0002` and `chaos-0003` settle at generation >= 2;
6. `chaos-0004` and `chaos-0005` settle at generation >= 3;
7. unresolved reservations reject `beginEffect` before settlement;
8. the fresh sweeper completes within 256 transitions;
9. every hosted controller wave starts from a fresh runner checkout;
10. the deterministic local contract reproduces the same six fault modes with a fresh Git repository for every logical controller wave.

Any violated invariant falsifies the bounded claim.

## Conditional liveness statement

This experiment does not claim magical progress under arbitrary partitions.

The bounded progress claim is:

```text
IF
  remote authority remains available
  AND the observation fixture remains stable
  AND fresh controllers continue taking steps

THEN
  the 48-obligation treatment reaches all-DONE
  within the preregistered 256-transition sweep bound
```

General scheduler fairness remains a separate experiment.

## Reproduce

```sh
npm run test:distributed-authority-chaos
```

Hosted execution is in:

```text
.github/workflows/distributed-authority-chaos.yml
```

## Non-claims

A positive result does not prove:

- an HA SLA;
- arbitrary provider mutation recovery;
- starvation freedom under arbitrary scheduling;
- multi-region partition tolerance;
- Byzantine fault tolerance;
- Git is the preferred production hot path;
- consensus is unnecessary;
- 48 obligations imply asymptotic scalability.

## Result

Supported at exact treatment revision `1d496629374cf83802680fe6ba33a35b9d17d8dc` in GitHub Actions run `35930448775`.

Observed durable result:

```text
obligations:                 48
final DONE:                  48
ClaimFacts:                  48
EffectReservationFacts:     24
chaos-0002 final generation: 2
chaos-0003 final generation: 2
chaos-0004 final generation: 3
chaos-0005 final generation: 3
fresh sweep transitions:     34 / 256 allowed
```

All 24 hosted controller-wave jobs passed. The generation-2 wave for `chaos-0004` and `chaos-0005` durably terminated immediately after authority rotation. A later fresh controller settled both at generation 3. The reserved `chaos-0005` path retained its unresolved reservation across both controller deaths and rejected replay before recovery.

The final verifier found exactly one durable claim per obligation and no duplicate reservation per run.

The treatment head also passed the standing Merge gate, Typed capability authority, Authority flow analysis, Effect authority decay, and Distributed authority handoff checks.

The local preflight population was reduced during development from 48 to one obligation per six fault modes because its purpose is algebra/harness validation, while the hosted 48-obligation treatment is the preregistered endurance population. The hosted population, fault schedule, generation thresholds, and sweep bound were unchanged.
