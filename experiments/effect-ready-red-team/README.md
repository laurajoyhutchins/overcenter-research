# Red team: effect-ready authority

These counterexamples attack the production-boundary refactor in PR #81 at exact
head `9ccb2d2734303ca51fa1e6708cc9056fe52d05e1`.

They are intentionally **passing counterexample tests**: green means the hostile
behavior is reproducible.

## Counterexample 1: late session rebinding

The intended argument is:

```text
worker generation 1
      ↓
TaskSession(g1)
      ↓
effect-ready
      ↓
expectedGeneration=1
      ↓
stale authority fails closed
```

The hosted implementation does not currently bind that session before the
worker runs. The broker reconstructs it from current project state after
receiving the worker artifact.

Therefore:

```text
worker emits effect-ready at g1
      ↓
trusted authority rotates to g2
      ↓
broker inspects current Work
      ↓
bindTaskSession(g2)
      ↓
old signal + new session
      ↓
acquire g3
      ↓
provider mutation
```

The signal contains no identity that lets the broker distinguish a g1 signal
from a g2 signal. Generation fencing is correct, but it fences the newly bound
session rather than the worker's original authority.

## Counterexample 2: postcondition becomes capability

PR #81 deliberately deleted the duplicate `packet.effect` and now derives the
provider command from the postcondition:

```text
GitHub status postcondition
      ↓
deriveAuthorizedProviderEffect
      ↓
create commit status
```

That removes duplication, but it also collapses **observation authority** and
**mutation authority**.

The counterexample defines an obligation whose packet explicitly says:

```json
{
  "kind": "observe-only/v1",
  "mutation_authorized": false
}
```

with a GitHub-status postcondition. A bare `effect-ready` signal still causes
the broker to issue a create-status mutation.

The packet flag is deliberately not proposed as the fix. It merely demonstrates
that no explicit effect authority exists in the current model.

## Consequence

PR #81 proves useful confinement mechanics, but these two stronger claims do not
yet hold:

1. a worker signal is bound to the authority generation under which the worker
   actually ran;
2. a postcondition is not itself sufficient authority to mutate the thing it
   verifies.

The likely repair is:

```text
dispatch
  ├── mint/bind immutable broker-side TaskSession(generation N)
  └── launch worker on transport already attached to that session

worker
  └── submit result / evidence

deterministic verifier
  └── accept realization

explicit effect authorization
  └── trusted adapter may derive concrete provider command

broker
  ├── require original TaskSession
  ├── require accepted realization / transition precondition
  ├── reserve
  └── execute
```

A bare worker `effect-ready` should not by itself be the fact that authorizes
an external effect.
