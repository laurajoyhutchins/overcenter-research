# Current realization admissibility

## Question

A historical settlement proved an exact obligation was DONE. What should current
project truth say after the mutable world changes?

The experiment tests the boundary:

```text
durable history
  historical DONE
        |
        v
pure replay
        +
fresh authoritative observation
        |
        v
current realization judgment
  admissible | rejected | indeterminate
        |
        v
projector
  DONE | READY | BLOCKED
```

Provider observation and verification remain outside the projector. The
projector receives only the judgment relation.

## Expected semantics

- **admissible**: fresh evidence still proves the current postcondition, so the
  exact historical realization remains DONE.
- **rejected**: fresh authoritative evidence proves the realization no longer
  satisfies the postcondition, so historical DONE no longer satisfies current
  truth and the work may become READY.
- **indeterminate**: current evidence cannot safely decide either way, so the
  work is BLOCKED rather than silently reused or replayed.

No invalidation fact or lifecycle repair mutation is written.

## Hostile cases

The executable proof uses both strongly observable and eventually consistent
file postconditions:

1. settle DONE and confirm current evidence preserves DONE;
2. mutate authoritative state to a known contradiction and require READY;
3. delete the strongly observed state and require READY from authoritative
   absence;
4. make eventually consistent readback stale or negative and require BLOCKED;
5. create a fresh kernel and reconstruct the same current status/explanation;
6. restore desired reality and require the original historical DONE to become
   DONE again with no new settlement.

## Running

```sh
npm run test:current-realization-admissibility
```
