# Automatic witness minimization

## Question

Can Overcenter start from an intentionally over-recorded execution, automatically minimize the observations required for deterministic recovery, then promote recurring minimized witnesses into a narrow capture contract that preserves recovery power on unseen executions without false certainty?

## Preregistered hypothesis

The strong hypothesis is that a capture contract learned only from minimized historical witnesses will preserve at least 95% of the broad recorder's `SAFE_RETRY` decisions on unseen schedules, including an alternate mutation route absent from training, while producing zero false `SAFE_RETRY` decisions.

A weaker secondary hypothesis is that post-hoc delta minimization can substantially shrink individual recovery witnesses while preserving the same deterministic proof.

## Blind setup

The minimizer sees only an observation list and a black-box deterministic verifier. It is not told which observation classes are semantically important.

Every broad trace contains 102 observations in the safe training cases:

- durable reservation;
- exact execution termination;
- active effect route;
- two redundant complete monitors for the ordinary effect route;
- one complete monitor for a hidden alternate helper route;
- 96 deterministic noise observations.

The two ordinary-route monitors are deliberately redundant so there is no unique minimal witness. Observation order varies by seeded shuffle. The hidden helper route never appears in training.

The verifier is fail-closed. A safe retry requires reservation, termination, route identity, and a complete monitor for that route with no recorded send. Missing completeness returns `RECOVERY_REQUIRED`.

## Procedure

1. Generate 80 ordinary-route training executions, half pre-send and half committed.
2. Run ddmin only over the 40 broad traces whose full evidence proves `SAFE_RETRY`.
3. Require every retained witness to be 1-minimal: deleting any remaining observation destroys the safe-retry proof.
4. Compile the union of observation capabilities implied by those minimized witnesses into a frozen capture contract.
5. Evaluate 100 held-out ordinary-route executions.
6. Evaluate 100 unseen helper-route executions, half pre-send and half committed.
7. Compare against the broad recorder's classifications and the independent committed-effect truth.
8. Run an unsafe negative control that treats an unobserved send as proof of non-occurrence even when the relevant monitor was never captured.

## Falsification

The strong hypothesis is falsified if either:

- the frozen learned contract preserves less than 95% of the broad recorder's deterministic `SAFE_RETRY` decisions on the unseen route; or
- it produces any false `SAFE_RETRY` for a committed effect.

The post-hoc minimization claim is separately weakened if mean observation reduction is below 90%, if a minimized witness changes the verifier result, or if any supposedly minimal witness still contains a removable observation.

## Run

```sh
npm run test:witness-minimization
```

## Result

GitHub Actions run `35821101302` evaluated the exact preregistered revision `77f1733b78f757a983a844d61ce07146f110791e`.

```text
training_safe_cases=40
broad_observations_mean=102.00
minimized_observations_mean=4.00
observation_reduction_pct=96.08
distinct_minimal_witness_shapes=2
learned_capture_contract=monitor-main-a,monitor-main-b,reservation,route,terminated
same_route_recovery_retention_pct=100.00
same_route_false_certainty=0
unseen_route_recovery_retention_pct=0.00
unseen_route_false_certainty=0
unsafe_unseen_false_certainty=50
strong_hypothesis=FALSIFIED
```

The strong promotion hypothesis is falsified. Historical minimized witnesses were sufficient to learn an excellent contract for the observed ordinary route, but they provided no evidence that the helper-route monitor could be discarded globally. The fail-closed verifier handled that epistemic gap safely by returning `RECOVERY_REQUIRED`, so the failure was liveness/recovery power rather than false certainty.

The unsafe negative control shows why capture completeness is part of the proof rather than bookkeeping: treating an unmonitored route as equivalent to an observed absence produced 50 false safe-retry decisions for committed helper effects.

The secondary post-hoc minimization result is positive. Every training safe-retry witness became 1-minimal at four observations on average, a 96.08% reduction, and redundant equivalent monitors produced two distinct valid minimal witness shapes rather than a fictional unique causal set.

## Interpretation and non-claims

A negative generalization result does not invalidate post-hoc witness minimization. It means historical minimality alone is insufficient authority for narrowing future capture across previously unseen effect routes.

The experiment is synthetic and bounded. It does not establish that 95% is the correct production threshold, that every provider exposes a finite route vocabulary, or that ddmin is the optimal minimizer.
