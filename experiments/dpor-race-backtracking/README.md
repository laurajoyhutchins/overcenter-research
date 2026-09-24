# DPOR race/backtracking explorer

## Question

Can Overcenter discover necessary alternative executions from **dependent races** and add backtracking choices at the earliest reorderable prefix, rather than relying only on sleep-set pruning over all locally enabled choices?

This experiment stacks on `dpor-causal-explorer`. It keeps exhaustive enumeration as an oracle and adds an explicit race/backtracking mechanism.

## Preregistered hypothesis

For the existing four-obligation corpus:

- exhaustive enumeration still contains exactly **369,600** schedules;
- safety semantics require exactly **1** causal execution and should discover no cross-obligation races;
- scheduler-sensitive semantics require exactly **24** causal executions and must discover races that add alternative claim roots to earlier backtracking sets;
- reduced and exhaustive canonical trace sets must be identical.

For conflicting effects, race detection must add a backtracking alternative and preserve both outcomes.

For a future conflict, where two initially independent roots later enable dependent effects, the explorer must discover the later race and backtrack to the other obligation's earliest enabled root. That control distinguishes actual race/backtracking from merely choosing among transitions that were already known to conflict at the initial state.

## Algorithm under test

Each explored prefix has a backtracking set. Initially the explorer selects one enabled event.

When a newly executed event is dependent with a prior event but neither event causally precedes the other, the pair is a race. The explorer inspects the state immediately before the prior event and finds the earliest enabled event from the later event's obligation. That event is inserted into the earlier prefix's backtracking set.

The DFS loop observes backtracking choices added by descendants, so a race discovered deep in one execution can cause a new branch at an ancestor prefix. Sleep sets remain as duplicate-trace pruning, but they do not create alternative executions.

## Hostile controls

### Immediate conflicting writes

Two root effects write incompatible values to the same canonical resource. The first execution must discover the dependency race and add the opposite root to the initial backtracking set.

### Future conflict

Two root claims commute. Each enables a later write to the same resource. The conflict is invisible at the initial state.

A passing explorer must detect the later dependent race, find the other obligation's enabled root at the relevant earlier prefix, and produce both causal classes and both final outcomes.

### Unsound independence

The deliberately wrong rule "different obligation IDs commute" must suppress the conflicting-write race and therefore miss one final outcome.

## Acceptance criteria

The treatment is supported only if:

1. exhaustive exploration contains exactly 369,600 schedules for the four-chain corpus;
2. safety race/backtracking exploration visits exactly one complete execution and its trace set equals exhaustive;
3. scheduler-sensitive race/backtracking visits exactly 24 complete executions and its trace set equals exhaustive;
4. scheduler-sensitive exploration discovers at least one dependent race and adds backtracking choices;
5. immediate conflicting writes produce two reduced executions and preserve both exhaustive outcomes through race-induced backtracking;
6. the future-conflict fixture contains six concrete schedules, two trace classes, and two outcomes, all preserved by exactly two reduced executions;
7. the future-conflict treatment records both a dependent race and an ancestor backtracking insertion;
8. the unsound distinct-obligation oracle suppresses the necessary race, explores one conflicting execution, and misses one final outcome.

## Reproduce

```sh
npm run experiment:dpor-race-backtracking
```

Hosted exact-head execution is in `.github/workflows/dpor-race-backtracking.yml`.

## Interpretation boundary

A positive result establishes the essential DPOR mechanism missing from the preceding sleep-set experiment: later dependency races can create new backtracking work at earlier prefixes.

## Non-claims

- This is an optimal Source-DPOR implementation.
- The obligation identifier is a universal process identity for arbitrary execution models.
- The independence oracle is complete for arbitrary provider effects.
- Liveness-preserving POR conditions have been proved.
- Unbounded executions are covered.
- Production scheduling should use DPOR.
- Authority serialization can be weakened.
