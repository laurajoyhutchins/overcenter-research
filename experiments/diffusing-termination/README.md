# Diffusing-computation termination detection

## Question

Can Overcenter distinguish temporary local quiescence from global completion once reasoning workers may recursively create descendant work?

The experiment borrows the accounting idea from Dijkstra-Scholten rather than copying its original network protocol literally:

```text
reserve descendant durably
        ↓
dispatch uncertain work
        ↓
deliver / execute / settle
        ↓
discharge exact causal delegation
```

A project is not complete merely because no worker is active. Completion additionally requires every causally outstanding delegation to be discharged and every spawn authority to be gone.

## Hypothesis

For the bounded model, the following ordering is sufficient to prevent false completion:

```text
durably account for descendant
        BEFORE
make descendant externally executable
```

Each delegation has a stable identity independent of semantic work identity. Two parents may converge on one deduplicated semantic obligation while still owning two separate causal acknowledgements.

Spawn authority is generation-bound. Rotating execution authority makes an old worker unable to introduce new descendants.

## Negative control

The deliberately naive detector is:

```text
active workers == 0  => COMPLETE
```

A parent reserves and dispatches a child, then becomes inactive before delivery. At that instant there are zero active workers while a message is still in flight. The naive detector must report a false completion.

The TLA+ negative-control configuration makes the same mistake and must produce an invariant counterexample.

## Hostile executable cases

The deterministic executable checks delayed delivery, recursive fan-out, crashes before and after dispatch, duplicate delivery/acknowledgement, stale spawn authority, convergent semantic work with distinct causal obligations, and cache-free replay.

The pre-dispatch crash may terminate only after an explicit safe cancellation. The post-dispatch crash may not be cancelled blindly.

## Safety criterion

```text
COMPLETE
  =>
no active workers
AND no live spawn authority
AND no reserved/in-flight/delivered-but-unacknowledged delegation
```

The executable projects this condition entirely from immutable facts. There is no trusted mutable outstanding-work counter.

## Formal model

`formal/DiffusingTermination.tla` models one parent and one dynamically delegated child. The durable detector may declare completion only after all accounted work is discharged and spawn authority has been revoked.

| Configuration | Detector | Expected |
| --- | --- | --- |
| `DiffusingTermination.cfg` | durable accounting | safety invariant holds; terminal state is eventually detected |
| `BrokenDiffusingTerminationNaive.cfg` | local-idleness only | TLC finds false completion |

## Reproduce

```sh
npm run experiment:diffusing-termination
npm run proof:formal
```

## Interpretation boundary

A positive result supports a narrow design rule for future recursive delegation: descendant work must enter durable authority before it can escape into an external worker or transport, and the ability to create descendants must be fenced like other execution authority.

It does not prove arbitrary evolving projects terminate. Scheduler fairness, transport delivery, provider availability, and worker progress remain separate assumptions.
