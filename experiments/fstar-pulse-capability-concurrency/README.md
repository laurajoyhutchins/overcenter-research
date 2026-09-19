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

`independent_parallel` starts with exclusive authority over two distinct coordinates:

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

Pulse must prove that the heap capability can be separated into the two worker preconditions and recombined afterward.

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

`same_coordinate_parallel` deliberately gives two parallel branches the same exclusive mutation capability. It is annotated `[@@expect_failure]`.

The module verifies only if Pulse rejects that attempted split.

## What success means

A green run supports this bounded claim:

> If mutation authority is represented as an exclusive separation-logic resource, parallel execution is admissible when the required resources are disjoint, while conflicting operations require explicit sequencing.

That is stronger than checking a scheduler's runtime bookkeeping after the fact. The parallel program itself is unverifiable unless the capability decomposition is valid.

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

With an F* distribution that includes Pulse:

```sh
bash experiments/fstar-pulse-capability-concurrency/check.sh
```

The hosted workflow pins the F* release bytes used for the proof.
