# Conditional scheduler liveness

## Question

Do the scheduler and recovery selection rules provide temporal progress under explicit assumptions, rather than merely good throughput?

The target property is intentionally conditional:

```text
IF
  authority remains available
  AND required provider observations eventually arrive
  AND a READY obligation continues to be eligible
  AND workers continue taking steps
THEN
  that obligation is eventually claimed
```

This experiment also tests the stronger open-system question that the current fixed-set fairness test does not answer: what happens when never-claimed work is introduced continually while recovered work remains READY?

## Formal model

`formal/SchedulerLiveness.tla` models one recovered target and one abstract fresh-work class.

The model does not assume progress for free:

- authority starts unavailable and becomes available under weak fairness;
- the recovery observation starts absent and arrives under weak fairness;
- only then does the target become continuously READY;
- scheduler steps themselves are weakly fair.

Three configurations are required:

| configuration | selector / environment | expected result |
| --- | --- | --- |
| `SchedulerLiveness.cfg` | current fresh-first then least-recently-selected policy; stable contender set | `TargetProgress` holds |
| `BrokenSchedulerUnfair.cfg` | fixed-priority selector | TLC temporal counterexample |
| `SchedulerFreshFlood.cfg` | current fresh-first policy; fresh unseen work replenished forever | TLC temporal counterexample |

The fresh-flood case is not a broken implementation fixture. It is a boundary probe. If it fails as expected, the broad liveness theorem needs either an admission assumption that excludes perpetual higher-priority arrivals or a stronger class-fair scheduler policy.

## Executable hostile scheduler

`experiment.ts` exercises the production `deriveProjectProjection()` selector with replayable READY receipts.

It runs three cases:

1. **Stable finite set.** A previously claimed recovery target competes with eight never-claimed obligations. At simulated concurrency 1, 2, and 4, the target must be selected after the finite fresh set receives its first claims.
2. **Broken fixed priority.** A deliberately unfair lexicographic selector repeatedly chooses `hot-a`; the recovery target must remain unselected for the bounded hostile trace.
3. **Continual fresh arrivals.** Before every simulated scheduling wave, enough new never-claimed obligations are admitted to fill every slot. The production selector is expected to keep choosing fresh work, leaving the recovery target unselected throughout the bounded trace.

The bounded hostile traces are executable witnesses, not proofs of infinity. TLC supplies the temporal counterexamples.

## Distinguishing result

A useful result is not simply “green.”

- Stable finite progress plus the fixed-priority counterexample demonstrates that the model can distinguish fair from unfair scheduling.
- A fresh-flood counterexample demonstrates that #207's fixed-set fairness guarantee is conditional rather than universal.
- If the fresh-flood case unexpectedly makes progress, the current fresh-first rule is stronger than the simple priority argument predicts and the executable trace must explain why.

Only after formal and executable behavior agree should we design production fairness machinery.

## Reproduce

```sh
npm run experiment:scheduler-liveness
npm run proof:formal
```

## Non-claims

- This does not prove provider availability.
- This does not prove arbitrary evolving projects terminate.
- This does not turn throughput into liveness.
- This does not authorize a scheduler policy change.
- A bounded executable trace is not a substitute for a temporal proof.


## Exact-head result

Evaluated revision: `b836d087dab036480ad2f45a8a4b63905f12b39a`

GitHub Actions: Merge gate run `35923909252`, exact-head candidate job `107394794686`.

The formal and executable results agree.

| Case | Result |
| --- | --- |
| Stable finite set, concurrency 1 | recovered target selected on claim opportunity 9, wave 9 |
| Stable finite set, concurrency 2 | recovered target selected on claim opportunity 9, wave 5 |
| Stable finite set, concurrency 4 | recovered target selected on claim opportunity 9, wave 3 |
| Broken fixed priority | only `hot-a` selected for 64 executable steps; TLC temporal counterexample |
| Continual fresh arrivals, concurrency 1 | target unselected across 16 selections; TLC temporal counterexample |
| Continual fresh arrivals, concurrency 2 | target unselected across 32 selections; TLC temporal counterexample |
| Continual fresh arrivals, concurrency 4 | target unselected across 64 selections; TLC temporal counterexample |

### Interpretation

The fixed-set fairness result from #207 is real but conditional. Bounded effect concurrency changes how many claim opportunities fit into a wave; it does not repair scheduler priority.

The broader theorem proposed for this experiment is false as stated. The fresh-flood trace satisfies the modeled progress assumptions:

- authority becomes and remains available;
- the required recovery observation arrives;
- the recovered target remains READY;
- scheduler steps continue forever.

Yet the target never gets selected because every scheduling opportunity can be consumed by a newly introduced never-claimed obligation.

A valid production theorem therefore needs one of two things:

1. an explicit environmental assumption that the higher-priority fresh class is not replenished forever; or
2. a scheduler policy that is itself fair across continuously eligible classes/identities, so new work cannot indefinitely outrank old recovered work.

This PR does not choose between those designs and does not change production scheduling.
