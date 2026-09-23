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

## Follow-on trial matrix: preregistration

The first result leaves open whether the problem is statistical, semantic, or structural. The following trials are preregistered before their hosted execution.

### T1: route-exposure sweep

Add 0, 1, 2, 4, 8, or 16 **safe** helper-route traces to the original main-route training set, freeze the union of 1-minimal witness capabilities, then challenge it on 200 helper-route executions.

Prediction to test: if route coverage rather than sample count is the limiting variable, zero helper examples will retain 0% helper recovery while even one valid helper safe-retry proof will be enough to retain 100% in this two-route model.

### T2: minimization stability under redundant evidence

Minimize 500 independently shuffled main-route safe traces. There are two semantically equivalent complete main-route monitors.

Measure the number and frequency of distinct 1-minimal witness shapes, their set intersection, and their union.

Prediction to test: individual minimal witnesses will be non-unique, while the intersection will contain only the proof-invariant core `reservation + route + termination`. Therefore literal feature intersection cannot itself define a complete capture policy.

### T3: fail-closed outcome asymmetry

Minimize 50 committed helper traces using only the predicate “the verifier still returns `RECOVERY_REQUIRED`.”

Prediction to test: because `RECOVERY_REQUIRED` is the verifier's safe default for missing evidence, delta minimization will reduce these cases to an empty witness. This would show that status preservation is insufficient: useful minimization targets must be positive propositions/proofs, not a generic fail-closed disposition.

### T4: guarded promotion

Learn the narrow main-route contract historically, then add the helper monitor from an **independently supplied complete mutation-route inventory**. Remove all remaining broad noise.

Success criterion: preserve 100% broad-recorder safe recovery across both routes with zero false certainty while retaining at most 10% of broad capture classes.

This tests the alternative architecture: learning may minimize *inside* a structurally certified observation envelope, but may not learn the envelope's completeness from historical absence.

### T5: broad shadow sampling

Assume an unseen helper route occurs in 1% of production executions. Compute geometric discovery latency for broad shadow-capture rates of 0.1%, 0.5%, 1%, 5%, and 10%.

Compare:

- structural route-novelty detection, which can react to any broadly captured helper execution; and
- safe-witness-only discovery, which needs the helper execution also to be pre-effect.

The purpose is to quantify whether probabilistic shadow capture is a plausible completeness mechanism or merely a backstop.

### Falsifying observations

These follow-on interpretations are rejected if:

- helper recovery rises smoothly with repeated same-route samples even without helper-route exposure, contradicting the route-coverage explanation;
- a unique literal minimal witness dominates despite redundant equivalent monitors;
- generic `RECOVERY_REQUIRED` minimization retains substantive causal evidence rather than collapsing to the fail-closed default;
- the independently guarded contract cannot preserve full recovery and zero false certainty; or
- shadow discovery is fast enough at tiny sampling rates to make structural route enumeration unnecessary in this model.


## T6: production source-boundary audit preregistration

The guarded-promotion result is only useful if the mutation-route envelope can be established independently. Before executing this audit, the trial is defined as follows:

1. recursively inspect every repository-owned TypeScript file under `src/`;
2. enumerate literal mutation-capable HTTP methods `POST`, `PUT`, `PATCH`, and `DELETE`, plus explicit curl mutation verbs;
3. enumerate `performEffect(...)` sites;
4. fail if any mutation-capable HTTP candidate occurs in a source file that does not also route through `kernel.performEffect(...)`.

This is intentionally only a bounded structural audit, not a proof of arbitrary runtime I/O completeness. Dynamic native calls, generated code, shell indirection, or mutation mechanisms not represented by the scanned syntax remain non-claims.

The useful result is whether the current production slice already has a mechanically enumerable mutation boundary that can serve as the certified envelope for learned witness minimization.

## Follow-on trial results

Hosted follow-on matrix: run `35821496326` at exact preregistered revision `d35c8e0208c68a8c6627ae93df17a73f02890db4`.

### T1: route exposure, not repetition, controls recovery

| Safe helper traces in training | Helper recovery retained |
| ---: | ---: |
| 0 | 0% |
| 1 | 100% |
| 2 | 100% |
| 4 | 100% |
| 8 | 100% |
| 16 | 100% |

One valid safe-retry proof from the previously unseen route was sufficient to retain that route's recovery capability in this model. More samples did not improve the result. The relevant missing variable was structural route coverage rather than repeated evidence from an already-covered route.

### T2: minimal witnesses are non-unique

Across 500 independently shuffled safe main-route traces:

- 258 minimized to `monitor-main-a + reservation + route + terminated`;
- 242 minimized to the equivalent `monitor-main-b + reservation + route + terminated`;
- their literal intersection was only `reservation + route + terminated`, which is insufficient for safe retry;
- their union retained both equivalent monitor capabilities.

Therefore neither “take one minimum” nor “intersect all minima” is a sound way to infer a future capture contract. Equivalent proof alternatives need an explicit semantic representation.

### T3: fail-closed dispositions are degenerate minimization targets

Fifty committed helper traces were minimized while preserving only the label `RECOVERY_REQUIRED`.

Mean minimized witness size: **0 observations**.

Because `RECOVERY_REQUIRED` is the verifier's default when evidence is missing, an empty trace preserves the label. The useful target for minimization must therefore be a positive proposition such as “this complete observation domain proves that no effect-bearing transmission occurred,” not a generic lifecycle state.

### T4: independently guarded promotion works

Adding the unseen helper monitor from an independently supplied complete mutation-route inventory produced:

- 6 retained capture classes out of 102;
- **94.12% capture-class reduction**;
- **100% recovery retention** across both routes;
- **0 false certainty**.

This supports a narrower architecture than the original learning claim: machine minimization can aggressively delete observations *inside a separately certified mutation envelope*.

### T5: shadow sampling is a backstop, not a completeness proof

For a hidden route occurring in 1% of executions, expected geometric discovery latency was:

| Broad shadow rate | Route-novelty median / p95 | Safe-witness median / p95 |
| ---: | ---: | ---: |
| 0.1% | 69,315 / 299,572 executions | 138,630 / 599,145 |
| 0.5% | 13,863 / 59,914 | 27,726 / 119,828 |
| 1% | 6,932 / 29,956 | 13,863 / 59,914 |
| 5% | 1,386 / 5,990 | 2,773 / 11,982 |
| 10% | 693 / 2,995 | 1,386 / 5,990 |

Sampling can detect drift eventually, but rare routes multiplied by low shadow rates create long blind intervals. Structural route enumeration is materially stronger.

## Production source-boundary audit result

Hosted audit: run `35821658065` at exact preregistered revision `48e67d48208105a47a2dbe35a8bd4bc5c8ed0402`.

The bounded static audit scanned 61 repository-owned TypeScript source files and found:

```text
network_or_process_sites=9
mutation_http_candidates=2
mutation_candidate=src/providers/github/pr-update-branch-effect.ts:22:PUT
mutation_candidate=src/providers/github/status-effect.ts:32:POST
perform_effect_sites=3
perform_effect_site=src/authority/engine.ts:330
perform_effect_site=src/providers/github/pr-update-branch-effect.ts:86
perform_effect_site=src/providers/github/status-effect.ts:102
mutation_candidates_outside_perform_effect_files=0
```

Within the syntax covered by this audit, the current production slice already has a mechanically enumerable mutation boundary: the two detected provider mutation sites both pass through `KernelCore.performEffect`.

This is not a proof that arbitrary runtime I/O cannot bypass the boundary. It is evidence that the present architecture is unusually favorable to deriving a complete effect-route inventory from trusted software structure rather than learning that inventory statistically from historical traces.

## Revised model

The experiments now support this division:

```text
trusted mutation-route inventory
          │
          ▼
broad complete observation envelope
          │
          ▼
execution + positive recovery proof
          │
          ▼
automatic witness minimization
          │
          ├── compact durable witness
          │
          └── candidate narrower instrumentation
                         │
                         ▼
              admitted only if envelope
              completeness is preserved
```

Historical witness minimization may optimize evidence and instrumentation. It must not be the source of authority for deciding which mutation routes exist.


## T7: learned positive recovery proof prototype

This trial is preregistered before hosted execution.

The hypothesis is narrower than automatic capture learning: given a separately supplied mutation-route topology, automatic minimization can learn a compact **positive proof expression** for effect non-occurrence without treating raw absence as evidence.

The topology declares:

- route `main` has two equivalent complete monitors, A and B;
- route `helper` has one complete monitor;
- each monitor has an explicit completeness event and an explicit effect event.

The learner receives only safe broad traces plus the deterministic positive verifier. For each route it:

1. delta-minimizes raw observations while preserving the positive proposition “effect non-occurrence is proved”;
2. converts each minimum to semantic atoms whose negative meaning is guarded by monitor completeness;
3. computes the atoms common to every minimum;
4. represents residual minima as alternative proof clauses rather than intersecting them away.

Expected learned shape:

```text
main:
  reservation-bound
  & generation-terminated
  & route:main
  & (main-a-clear | main-b-clear)

helper:
  reservation-bound
  & generation-terminated
  & route:helper
  & helper-clear
```

The generated proof is then compared with the original deterministic verifier over an exhaustive hostile Boolean table containing both physically normal and deliberately contradictory combinations of completeness and send events.

### Falsification

The prototype is falsified if any of the following occurs:

- the learner collapses the two equivalent main monitors into a conjunction;
- the learner omits reservation, termination, or route identity;
- missing monitor completeness is accepted as evidence of absence;
- a send through a complete monitor still satisfies that monitor's `clear` predicate;
- the learned proof disagrees with the deterministic verifier on any hostile truth-table case;
- any disagreement produces false certainty.

This remains an experiment. It does not grant the learned expression settlement or retry authority.

## T7 result: positive recovery proof learning

Hosted run `35822236282` evaluated revision `d484b5b86cc0187e85e14af5c42cfb75e7f2ac75`.

The learner produced:

```text
main:
  generation-terminated
  & reservation-bound
  & route:main
  & (main-a-clear | main-b-clear)

helper:
  generation-terminated
  & helper-clear
  & reservation-bound
  & route:helper
```

The two equivalent main-route monitors remained alternatives rather than being incorrectly intersected. The helper route normalized to a single conjunction because it has only one proof alternative.

The learned expressions were compared against the original deterministic verifier over an exhaustive hostile Boolean table:

```text
hostile_truth_table_cases=512
hostile_truth_table_agreement=512
false_certainty=0
false_negatives=0
missing_completeness_fails_closed=true
committed_monitor_invalidates_clear=true
equivalent_monitor_recovers=true
```

Two earlier hosted attempts exposed only representation bugs in the prototype's Boolean normal form: first, a single helper proof was factored entirely into the required conjunction; second, that fully factored clause was represented as one empty alternative instead of no alternative branch. Neither failure passed the semantic equivalence gate. The corrected representation leaves the verifier-equivalence test unchanged.

This supports the narrower mechanism under test: within a separately certified route topology, minimized positive witnesses can be generalized into a compact executable proof expression without turning unobserved events into evidence.

The result does **not** authorize the learned expression for production settlement or retry. Admission still requires binding the proof to exact execution identity, durable reservation, route-topology version/identity, and a trusted completeness claim for each semantic monitor predicate.


## T8: authority-bound learned recovery certificate

This trial is preregistered before hosted execution.

T7 showed that a learned positive proof can reproduce the deterministic verifier. T8 asks whether such a proof can be packaged so that success for one execution cannot be replayed or substituted into another.

The prototype mints a recovery certificate only after a positive proof succeeds. The certificate is bound to:

- run ID;
- obligation ID;
- claimed revision;
- claim commit;
- obligation semantic key;
- execution generation;
- execution-authority commit;
- durable effect-reservation commit;
- exact effect route;
- mutation-topology digest;
- admitted learned-proof digest; and
- exact witness digest.

The consumer additionally treats the certificate as single-use.

### Hostile cases

Minting must reject mismatched execution identity, stale generation/authority, different reservation, route substitution, topology substitution, missing generation termination, missing monitor completeness, and observed effect transmission.

Consumption must reject mutation of every bound field, substitution of an unadmitted learned proof, reuse of the same certificate, a different but semantically equivalent witness, and topology drift.

A module-local unforgeable token plus private runtime bindings is used so a structurally similar JavaScript object cannot stand in for a minted certificate.

### Falsification

The treatment is falsified if any hostile substitution reaches the simulated retry consumer, if a certificate survives a topology or proof-policy change, if the same certificate can be consumed twice, or if missing completeness can contribute a positive recovery atom.

This remains an architectural experiment. The real `KernelCore` settlement/retry path is not changed by T8.
