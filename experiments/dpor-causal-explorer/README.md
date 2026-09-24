# Dynamic partial-order causal explorer

## Question

Can Overcenter use the causal-independence relation from `causal-execution-quotient` during exploration so that it executes one representative per relevant trace class instead of enumerating every concrete serialization first?

This is a bounded **sleep-set partial-order reduction** experiment with runtime independence queries and exhaustive enumeration retained as an oracle. It is the next implementation rung toward DPOR, not a claim that a full Source-DPOR algorithm has been implemented.

## Preregistered hypothesis

For the existing four-obligation corpus:

```text
claim -> reserve -> receipt
```

with four disjoint obligation chains:

- exhaustive enumeration visits exactly **369,600** complete schedules;
- safety-sensitive reduction visits exactly **1** complete execution;
- scheduler-sensitive reduction visits exactly **24** complete executions because claim order remains observable;
- every reduced execution corresponds to a distinct exhaustive Mazurkiewicz trace;
- the reduced and exhaustive trace-key sets are exactly equal.

The reduction must also preserve all outcomes when conflicts appear later than the initially independent roots.

## Algorithm under test

The explorer carries a sleep set while traversing enabled events.

After choosing event `t`, a previously slept event remains asleep only if the independence oracle says it commutes with `t`. Dependent alternatives are therefore reawakened and explored.

The oracle is queried during traversal. It conservatively treats:

- same-obligation events as dependent;
- explicit causal ancestors/descendants as dependent;
- events touching the same canonical resource as dependent;
- claim/claim pairs as dependent in scheduler-sensitive mode.

This is intentionally smaller than full Source-DPOR. The experiment asks whether direct partial-order exploration is already justified before adding more elaborate race/backtracking machinery.

## Hostile controls

### Conflicting writes

Two root effects write different values to the same canonical provider coordinate.

Exhaustive exploration has two executions and two final outcomes. The conservative reduced explorer must preserve both.

The intentionally unsound rule "different obligation IDs commute" must reduce the pair to one execution and therefore miss one outcome.

### Future conflict

Two initially independent root claims each enable a later effect on the same resource.

The reduced explorer must preserve the exhaustive trace classes and both final outcomes. This catches a reduction that sleeps an alternative permanently merely because the roots themselves commute.

## Acceptance criteria

The treatment is supported only if:

1. exhaustive exploration visits exactly 369,600 complete schedules for the four-chain corpus;
2. the safety-sensitive reduced explorer visits exactly 1 complete execution;
3. the scheduler-sensitive reduced explorer visits exactly 24 complete executions;
4. reduced and exhaustive canonical trace-key sets are exactly equal in both modes;
5. each reduced complete execution represents a distinct trace class;
6. conservative reduction preserves both outcomes of the conflicting-write fixture;
7. conservative reduction preserves both outcomes and all trace classes of the future-conflict fixture;
8. the intentionally unsound distinct-obligation oracle visits one conflicting-write execution and misses one final outcome.

## Reproduce

```sh
npm run experiment:dpor-causal-explorer
```

Hosted exact-head execution is in `.github/workflows/dpor-causal-explorer.yml`.

## Interpretation boundary

A positive result supports moving causal equivalence from a post-hoc normalization tool into the explorer itself. It would show that, for the bounded corpus, Overcenter can avoid generating enormous numbers of redundant schedules while preserving the property-sensitive distinctions established by the prior experiment.

## Non-claims

- This is a complete or optimal implementation of Source-DPOR, Optimal-DPOR, or unfolding-based model checking.
- The independence oracle is complete for arbitrary provider effects.
- The reduction is proved correct for unbounded executions.
- Liveness-preserving POR conditions are established.
- Production scheduling should use sleep sets.
- Project authority serialization can be weakened.
- Provider receipts or evidence can be removed.
