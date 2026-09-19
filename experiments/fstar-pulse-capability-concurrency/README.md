# F*/Pulse capability-concurrency experiment

## Question

Can Overcenter's concurrency rule be represented as a proof obligation over mutation authority rather than as scheduler convention?

The experiment models one provider mutation coordinate as one mutable reference. In Pulse, exclusive `pts_to` ownership of that reference is the capability required to mutate it.

That gives the experiment a deliberately small correspondence:

```text
provider mutation coordinate
          │
          ▼
       ref int
          │
          ▼
exclusive pts_to ownership
          │
          ▼
 mutation capability
```

The values stored in the references are unimportant. The ownership structure is the experiment.

## Controls

### Disjoint authority may run concurrently

`independent_parallel` starts with exclusive authority over two separable coordinates:

```text
left |-> v1    **    right |-> v2
     │                    │
     ▼                    ▼
 worker A              worker B
     │                    │
     └─────── par ────────┘
              │
              ▼
left |-> v1+1  **  right |-> v2+1
```

Pulse proves that the heap capability can be separated into the two worker preconditions and recombined afterward.

### Conflicting authority is legal when ordered

`same_coordinate_sequential` mutates one coordinate twice. The first operation returns ownership before the second consumes it.

This is the graph interpretation we want:

```text
effect A -> effect B
```

not:

```text
effect A + effect B = forbidden
```

### Conflicting authority may not be split concurrently

`HostileAlias.fst` calls the verified `independent_parallel` function with the same concrete coordinate in both argument positions while possessing only one exclusive `pts_to` capability.

The runner requires that this module fail compilation specifically because Pulse reports that it **cannot prove the second `pts_to coordinate before`** obligation. An unrelated compiler or syntax failure does not count.

## What success means

A green run supports this bounded claim:

> If mutation authority is represented as an exclusive separation-logic resource, parallel execution is admissible when the required resources are separable, while conflicting operations require explicit sequencing.

That is stronger than checking a scheduler's runtime bookkeeping after the fact. A caller cannot alias one exclusive mutation capability into two parallel workers while remaining verified.

## Safety, not liveness

Pulse's current `par` primitive is divergence-typed, so `independent_parallel` is explicitly declared `divergent`.

Accordingly this experiment proves a **safety** property about capability separation. It does not prove that parallel workers terminate or that Overcenter eventually makes progress. That distinction matches Overcenter's existing separation of safety claims from liveness claims.

## What this does not prove

This experiment does not prove that:

- real provider credentials are physically coordinate-scoped;
- Overcenter's graph currently derives the exact capability footprint of every effect;
- read-only and fractional capabilities are modeled correctly;
- effect footprints cannot change after admission;
- distributed workers possess only the capabilities represented in Pulse;
- the production scheduler is race-free.

Those are the bridge from the proof model to the real execution substrate.

## Run

With the pinned F* distribution that includes Pulse:

```sh
bash experiments/fstar-pulse-capability-concurrency/check.sh
```

The hosted workflow pins the F* release bytes used for the proof.

## Current-head confirmation

Exact evaluated revision `044781dba4087c8013658a68c1bb654e96809392` passed the Pulse verification workflow `35462466594`, repository Evidence `35462466575`, and disposable-agent trust proof `35462466586`. The earlier successful implementation revision remains useful history, but this is the current evaluated code identity.
