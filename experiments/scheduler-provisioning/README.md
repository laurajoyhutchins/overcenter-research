# Scheduler provisioning

## Question

Is the scheduler's negative N-way scaling primarily caused by many workers independently selecting and claiming the same scalar READY choice, or does serialized settlement remain the dominant limit even after that claim herd is removed?

## Design

This experiment compares two uses of the unchanged production `OvercenterKernel` over the same 32 independent local-file obligations.

### Herd mode

Each worker independently repeats:

```text
derive one global READY choice
        ↓
claim exact revision
        ↓
materialize
        ↓
settle
```

This is the current scaling workload and intentionally recreates the claim herd.

### Provisioned mode

One deterministic provisioner first claims distinct READY obligations through the normal production API and captures their exact `ExecutionPermit` values. Those already-fenced assignments are then partitioned across N disposable worker processes:

```text
one provisioner
  READY → claim → permit
  READY → claim → permit
  READY → claim → permit
          ↓
     assignment set
      ↙   ↓   ↘
 workers execute + settle in parallel
```

Provisioning time is included in end-to-end throughput. No direct SQLite mutation, alternate claim schema, or relaxed revision check is introduced.

## Why this experiment comes before batched claims

Different workers choosing different obligation IDs would still race the same global authority head. That cannot prove useful parallel admission.

A single provisioner removes only the redundant selection/claim race while preserving the existing serialized authority contract. If this materially restores scaling, assignment provisioning is a justified software boundary. If it does not, claim batching would optimize the wrong layer and settlement/CAS serialization needs attention first.

## Measurements

For 1, 2, 4, and 8 workers the experiment reports:

- end-to-end tasks/s for herd and provisioned modes;
- speedup relative to each mode's one-worker case;
- provisioner latency and claims/s;
- contention retries;
- provisioned/herd throughput ratio.

## Reproduce

```sh
npm run experiment:scheduler-provisioning
```

The hosted workflow runs the exact repository Node version on Ubuntu with a three-minute ceiling.

## Success criteria

The experiment is valid when both modes settle exactly 32 unique obligations `DONE` through production authority and exact permits, and all reported completion counts reconcile.

A green run is not itself a claim that provisioning should become a permanent singleton service. The measured comparison decides whether that boundary earns further implementation work.

## Non-claims

- This does not prove distributed or HA authority.
- This does not make settlement writes concurrent.
- This does not prove fairness when scheduler capacity is one.
- This does not justify a new batch-claim fact schema unless the measurement shows provisioning itself is the next material cost.
- Absolute throughput is host-dependent.


## Hosted result

Exact evaluated revision: `f34b9cc4b5bf794f0d28e9b30f2a2271b70b1422`

GitHub Actions run: `35570409213` on Ubuntu 24.04 / repository Node version.

### Herd versus pre-provisioned claims

| Workers | Herd tasks/s | Provisioned tasks/s | Provisioned / herd | Herd retries | Provisioned retries |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 49.366 | 64.581 | 1.308x | 0 | 0 |
| 2 | 39.237 | 44.825 | 1.142x | 34 | 0 |
| 4 | 21.740 | 22.208 | 1.022x | 73 | 0 |
| 8 | 11.431 | 15.489 | 1.355x | 192 | 0 |

Provisioning removes worker-side claim collisions completely, but it does **not** restore positive N-way scaling. Provisioning itself sustains roughly 220–317 exact claims/s, so claim issuance is not the limiting throughput at this workload size.

### Fixed-head durable validation

A separate control uses 1,024 total `SqliteFactStore.history()` reads over the same fixed 96-commit durable prefix.

| Processes | Validated reads/s |
| ---: | ---: |
| 1 | 1,290.876 |
| 2 | 1,305.463 |
| 4 | 867.575 |
| 8 | 497.949 |

Multi-process history validation degrades, but even the 8-process result remains more than thirty times the 8-worker provisioned settlement throughput.

### External-head catch-up

A lagging kernel is primed at the post-provisioning head, another kernel settles K assigned runs, and the lagging kernel then reconstructs the new current head.

| External settlements | Catch-up | ms / settlement |
| ---: | ---: | ---: |
| 1 | 1.504 ms | 1.504 |
| 2 | 2.134 ms | 1.067 |
| 4 | 3.400 ms | 0.850 |
| 8 | 6.399 ms | 0.800 |
| 16 | 14.552 ms | 0.909 |

Incremental semantic catch-up is therefore also too small to explain the observed 8-worker collapse.

## Diagnosis

The original claim-herd hypothesis is **not** the dominant explanation.

```text
claim provisioning          ~220–317 / second
fixed-head validation       ~498 / second at 8 processes
semantic catch-up           ~0.9 ms / external receipt
provisioned settlement      ~15.5 / second at 8 workers
```

The remaining high-cost boundary is the optimistic settlement loop itself. Each worker independently reads a global authority head, validates its permit/lifecycle, observes provider truth, constructs a receipt, and then attempts a head-fenced append. Concurrent unrelated settlements can advance that global head during the pre-append work, forcing the losing worker to repeat the loop internally.

The next experiment should therefore keep authority mutation in one deterministic software lane while allowing external effects to overlap. That tests the existing architectural principle directly: parallelize uncertain/effectful work, serialize execution correctness.
