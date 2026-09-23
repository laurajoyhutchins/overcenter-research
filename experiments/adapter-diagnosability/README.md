# Adapter diagnosability

## Question

Can a small discrete-event-system analysis classify whether an adapter protocol can ever distinguish `mutation occurred` from `mutation did not occur` using only its declared observations, and can it detect when that distinction arrives too late to make authority reuse safe?

## Preregistered hypothesis

For the bounded finite-state corpus below, a synchronized two-world product over equal observable traces will:

1. classify deliberately recoverable and deliberately non-diagnosable protocols correctly;
2. distinguish eventual diagnosability from diagnosis before a consequential retry, authority release, or DONE transition;
3. emit an explicit indistinguishable execution witness for every non-diagnosable protocol;
4. agree with an independently implemented depth-12 trace enumerator on whether ambiguity persists at the bounded horizon;
5. fail the correlated-receipt case when the receipt observation is deliberately collapsed so mutation and non-mutation produce the same observation.

The experiment is falsified if any preregistered fixture is misclassified, a required witness is absent, the independent oracle contradicts the product checker, or the uncorrelated-receipt negative control survives.

## Treatment

The experiment models a provider adapter as a finite transition system. States carry hidden mutation reality (`occurred` or `not-occurred`). Transitions may emit an observation visible to recovery and may be marked consequential when correctness depends on knowing mutation reality.

The checker constructs a synchronized product of two executions:

- unobservable transitions may advance either side independently;
- observable transitions advance together only when both sides emit the same observation;
- a product state is ambiguous when the two sides disagree about mutation reality.

A reachable cycle consisting entirely of ambiguous product states is reported as non-diagnosable. If there is no ambiguous cycle, the checker reports the longest observable path that can remain ambiguous. Safe diagnosability additionally requires that no consequential transition be reachable while the observer is still in an ambiguous product state.

This experiment intentionally uses a bounded finite-state abstraction. It does not yet model arbitrary provider state, real time, or unbounded fairness assumptions.

## Fixtures

Seven protocols are fixed before hosted execution:

1. `undispatched`: connection failure proves no mutation path exists.
2. `ambiguous-timeout`: commit and reject worlds both yield timeout and indefinitely identical negative observations.
3. `receipt`: an authoritative correlated receipt distinguishes the two worlds.
4. `stale-get`: an indefinitely stale GET keeps commit and non-commit worlds observationally identical.
5. `bounded-eventual-webhook`: one stale observation is allowed, then a bounded webhook guarantee distinguishes the worlds.
6. `too-late`: a receipt eventually distinguishes the worlds, but authority release is reachable while they are still ambiguous.
7. `same-final-state`: an idempotent mutation and no mutation both produce the same desired resource state forever.

Expected classifications:

| Protocol | Diagnosable | Safe-diagnosable |
| --- | --- | --- |
| `undispatched` | yes | yes |
| `ambiguous-timeout` | no | no |
| `receipt` | yes | yes |
| `stale-get` | no | no |
| `bounded-eventual-webhook` | yes | yes |
| `too-late` | yes | no |
| `same-final-state` | no | no |

## Independent oracle

The product checker is not allowed to grade itself. A separate brute-force enumerator expands complete transition traces to depth 12, groups them only by their emitted observation sequence, and asks whether a group still contains both mutation realities.

For every fixture classified non-diagnosable, at least one depth-12 ambiguous observation sequence must remain. For every fixture classified diagnosable, none may remain at depth 12.

This bounded oracle is a bug detector for the checker, not an independent proof of diagnosability.

## Negative control

The `receipt` fixture is mutated so `RECEIPT_PRESENT` and `RECEIPT_ABSENT` both become the single observation `RECEIPT`. The checker must then classify the protocol as non-diagnosable. If it remains diagnosable, the experiment fails.

## Reproduce

```sh
npm run test:adapter-diagnosability
```

No network, provider credential, production database, or LLM is required.

## Acceptance criteria

The experiment is informative only if:

1. all seven fixture classifications exactly match the preregistered table;
2. every non-diagnosable fixture emits a concrete ambiguous-cycle witness;
3. `too-late` is diagnosable but not safe-diagnosable, with `release-authority` identified while ambiguity remains;
4. the independent depth-12 oracle reports persistent ambiguity for all and only the three non-diagnosable fixtures;
5. the uncorrelated-receipt negative control is killed;
6. the experiment runs deterministically with Node type stripping and no runtime dependency additions.

## Interpretation boundary

A positive result would show that DES-style diagnosability is mechanically useful on a deliberately tiny effect-protocol abstraction and that safe diagnosability expresses a distinction Overcenter cares about: knowing the outcome eventually is weaker than knowing it before authority can be reused.

It would not yet establish that arbitrary real adapters can be abstracted conservatively at acceptable cost. The next falsifying step would be to encode one existing production-adapter uncertainty boundary without changing the checker and test whether the derived boundary agrees with the independently established runtime result.

## Non-claims

This experiment does not prove:

- diagnosability of arbitrary or infinite-state provider protocols;
- correctness of the finite abstraction relative to GitHub, Kubernetes, GCP, or another provider;
- wall-clock bounded diagnosis or unbounded fairness properties;
- that ordinary final-state equality proves a particular mutation occurred;
- that a suggested observation is trustworthy merely because it separates two abstract states;
- production readiness of the checker or permission to use it as settlement authority.

## Result

Pending exact-head hosted evaluation. A pre-commit local execution on Node 22.16.0 matched all seven preregistered classifications, the depth-12 oracle agreed, `too-late` was separated from ordinary diagnosability, and the uncorrelated-receipt negative control was killed. This local result is developmental evidence only until reproduced from the exact committed revision.
