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
