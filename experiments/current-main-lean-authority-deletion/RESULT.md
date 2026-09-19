# Result: current-main Lean authority deletion

## Exact evidence

Current-main base:

`1f6ad04704b3ed594c58ad5a5759be5048c3843d`

Pinned Lean reference:

`0c5db60f2dc14af93f554fd9f870181261ce5f11`

GitHub Actions run:

`35465310362`

Job:

`105956449198`

The experiment modeled current historical replay by validating every prefix of a
valid 100-obligation chain.

## Measured replay cost

| Implementation | 100-prefix cumulative replay |
| --- | ---: |
| current TypeScript `validateGraph` | **14.522 ms** |
| Lean one process per validation | **3,721.874 ms** |
| Lean persistent process | **82.171 ms** |

The one-shot replacement added:

**3,707.352 ms**

The frozen acceptance ceiling was:

**<= 500 ms added replay cost**

Therefore:

**THE DROP-IN ONE-PROCESS-PER-VALIDATION LEAN RUNTIME INTEGRATION FAILS.**

The threshold was not changed after observation.

## Correctness

Behavioral parity passed for every valid replay prefix.

Both implementations also failed closed on the two hostile structural fixtures:

- unknown dependency;
- dependency cycle.

So the experiment did not discover a semantic disagreement in the tested slice.

## Interpretation

This result does **not** falsify Lean as a semantic technology.

The persistent process completed the same 100-prefix replay in 82.171 ms, which
is close enough to ordinary control-plane scale to show that the semantic work
and serialization are not the dominant problem.

The failing cost is the process boundary repeated at every historical
definition:

```text
100 historical definition states
            |
            +--> 100 fresh Lean processes
                        |
                        +--> ~3.7 seconds cumulative
```

This is structurally different from the earlier benchmark question, which asked
whether one semantic decision could fit inside a latency budget.

Current replay requires a sequence of decisions over intermediate authoritative
states.

## Authority-deletion finding

A call to Lean only from `validateAdmission()` would not satisfy the
authority-deletion objective.

Current main also validates graph structure during historical replay in
`src/projection.ts`. In addition, projector recursion contains a cycle guard
that currently acts as defensive protection around direct projection use.

Therefore a production design must establish one graph-truth boundary used
consistently by:

- new definition/amendment admission;
- exact historical replay;
- projection invariants.

Keeping TypeScript graph validation in replay while adding Lean to admission
would create two authorities rather than delete one.

## Why persistent Lean does not make this experiment pass

Persistent Lean is diagnostically strong:

**82.171 ms for all 100 prefixes**

But adopting it would introduce a new long-lived process lifecycle into a core
replay path that is currently a synchronous pure computation.

That may still be a good architecture, but it is **not** a drop-in port. The
frozen experiment explicitly required a separate justification for a daemon or
persistent-process design.

The result therefore distinguishes:

```text
Lean semantic computation
        PASS

drop-in subprocess integration
        FAIL

persistent/embedded integration
        UNDECIDED
```

## Important limitation

The pinned Lean executable evaluates the broader frozen claim-admission protocol,
not a graph-only protocol. It therefore performs more semantic work than a
minimal graph verifier would.

That does not rescue the one-shot result: the measured failure is dominated by
100 process launches, and the persistent run demonstrates that the in-process
semantic work is comparatively small.

A graph-only executable could reduce the 82 ms persistent number, but it cannot
plausibly remove the repeated native-process startup boundary that produced the
3.7 second one-shot replay without changing the integration architecture.

## Recommendation

Do **not** port the Lean kernel into current production as a per-decision
subprocess.

Keep the proved Lean work as the specification/evidence reservoir.

If runtime Lean is still desired, the next experiment should test one of these
as an explicit new architecture:

1. an embedded/native-library boundary callable synchronously from the current
   replay kernel; or
2. a persistent deterministic Lean service with lifecycle, crash, restart,
   version-fencing, and exact-binary-identity semantics designed as first-class
   authority machinery.

The embedded/native-library experiment is the preferable next test because it
has a chance to delete TypeScript graph authority without adding daemon state or
making historical replay depend on a long-lived sidecar.

Until one of those earns its keep, TypeScript should remain the production graph
runtime and Lean should remain the proof/reference implementation.
