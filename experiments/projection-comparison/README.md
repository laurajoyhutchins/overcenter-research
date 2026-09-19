# Projection implementation comparison

## Question

Is Overcenter's relational projection boundary merely elegant, or does it beat
plausible alternatives on properties the product actually needs?

This experiment compares four implementations over the same normalized
projection contract:

```text
A. authoritative mutable SQLite lifecycle
B. production TypeScript deriveProjectProjection()
C. status-free SQLite + SQL derivation
D. Soufflé Datalog derivation
```

The experiment is allowed to conclude that B or C is the best production
implementation. Datalog is not treated as the presumed winner.

## Common boundary

All derived implementations receive the same current semantic judgments:

- current semantic obligation key;
- historical runs and latest settlement evidence;
- current realization admissibility;
- current dependency graph.

Semantic-key computation, provider evidence interpretation, structural replay
validation, mutation authority, and CAS are outside this comparison.

## Hostile transitions

The shared corpus exercises:

1. a dependency graph before execution;
2. exact-key historical DONE reuse;
3. a material semantic change with historical DONE left intact;
4. a new exact-key execution;
5. recovery-required settlement;
6. later successful settlement;
7. withdrawal of current realization admissibility after external drift;
8. WAITING;
9. accepted absence returning work to READY;
10. fan-out reconstruction.

The key adversarial transition is:

```text
historical DONE @ K1 remains durable
             +
current meaning becomes K2
             |
             v
current answer must change
without deleting historical evidence
```

## What is measured

### Projection agreement

TypeScript, SQL, and Datalog must derive identical public statuses from the
same normalized facts.

### Correctness-sensitive repair writes

The mutable lifecycle baseline is allowed to repair itself after a semantic
change. The experiment counts the lifecycle-row writes required to turn its
stale answer into the new correct answer.

Derived implementations perform zero status writes because status is not
durable input.

### Projection erasure

Derived implementations are rebuilt from their inputs in a fresh evaluator.
The mutable baseline has its lifecycle rows erased. If it cannot answer until
some additional repair/replay mechanism reconstructs those rows, the erasure
property fails.

### Storage-engine control

Both A and C use SQLite. If C survives erasure and semantic change without
status repair while A does not, the result is about the state model rather
than an anti-SQLite preference.

## Important non-claims

This experiment does not prove:

- Soufflé is the best production runtime;
- SQL will scale better than TypeScript;
- all event-sourced materialized views are equivalent to authoritative mutable
  lifecycle;
- derived projection eliminates the need for coordination at mutation
  boundaries.

An event-sourced system whose status view is disposable is architecturally in
the derived-projection family for purposes of this experiment.

## Running

Requires Soufflé 2.5:

```sh
npm run test:projection-comparison
```

The GitHub Actions workflow pins the exact Soufflé package bytes and verifies
the exact PR head before running the comparison.

## Observed result

Exact-head run `35424249863` passed the full comparison.

| Property | Mutable SQLite lifecycle | TypeScript projector | SQLite + SQL derivation | Soufflé Datalog |
| --- | --- | --- | --- | --- |
| Shared hostile status corpus | correct only while repair paths are invoked | pass | pass | pass |
| Semantic-key change with old DONE retained | stale until lifecycle repair | recomputes | recomputes | recomputes |
| Withdraw current realization admissibility | stale until lifecycle repair | recomputes | recomputes | recomputes |
| Two-node semantic invalidation | 2 durable status writes | 0 status writes | 0 status writes | 0 status writes |
| 20-leaf fan-out invalidation | 21 durable status writes | 0 status writes | 0 status writes | 0 status writes |
| Delete materialized lifecycle | cannot answer until rebuilt | reconstructs | reconstructs | reconstructs |
| Additional production runtime | SQLite state machine | none beyond current TS runtime | Node SQLite | Soufflé runtime/toolchain |

The important result is **not** that Datalog beats every alternative.

The experiment falsifies authoritative mutable lifecycle as the preferred model for
the tested Overcenter requirements. Its repair burden grows with the number of
materialized answers affected by a semantic change, and deleting those answers
destroys its ability to report project state until another reconstruction
mechanism is introduced.

The status-free SQL implementation is the crucial control. It uses SQLite too,
yet has the same reconstruction and zero-status-write properties as TypeScript
and Datalog. The architectural win therefore comes from **deriving status from
facts**, not from choosing a particular storage engine or language.

Among derived implementations, this experiment does **not** establish a
production winner:

- TypeScript already fits the runtime and has no additional deployment surface;
- SQL remains a credible production alternative if the fact store becomes
  relational;
- Datalog is the smallest declarative rule surface in this experiment, but adds
  a dedicated runtime/toolchain.

The current production choice therefore remains justified as:

```text
architecture: derived relational projection
production implementation: TypeScript
independent executable oracle: Datalog
credible future alternative: SQL over a relational fact store
```

An event-sourced system with a fully disposable materialized view would also
belong to the derived-projection family. This experiment does not claim that
such an implementation is worse.
