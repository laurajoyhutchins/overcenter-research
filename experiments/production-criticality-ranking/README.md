# Production callable criticality ranking experiment

## Question

Can Overcenter maintain a reproducible total ordering of the importance of its **production code** from quantitative facts rather than periodically repeating a human ranking exercise?

The ranked population in this first experiment is intentionally narrow:

```text
ranked:       executable callables under src/
evidence:     src/ + test/ + experiments/ + git history
not ranked:   tests, experiments, docs, fixtures, workflows
```

This does **not** yet claim that a callable is the final atomic unit. The experiment first asks whether an executable-callable graph produces a useful ordering. If it does, critical callables can later be refined into invariant/branch-level semantic units without changing the vector or ranking-policy model.

## Existing software used

The experiment deliberately avoids inventing a parser or history engine:

- TypeScript compiler API 5.8.3 supplies the AST, symbols, resolved signatures, and approximate static call graph.
- Git supplies exact-revision history and line-level blame timestamps.
- The experiment code only derives Overcenter-specific metrics and graph relations from those facts.

A later comparison can replace or corroborate the TypeScript call graph with CodeQL without changing the metric schema.

## Quantitative vector

Every ranked production callable receives a vector `v = (A, B, I, F, R, E, X, C)`, each normalized to `[0,1]`.

| component | measurement |
| --- | --- |
| `A` authority | fraction of declared semantic authority classes whose sink can reach the unit or can be reached by the unit |
| `B` blast radius | log-normalized count of transitive production callers/dependents |
| `I` irreversibility | maximum recovery class of influenced authority sinks, normalized by the configured maximum |
| `F` fan-out/centrality | geometric mean of normalized direct dependents and transitive dependent fraction |
| `R` recovery criticality | fraction of declared recovery scenarios in which the unit dominates the terminal call |
| `E` evidence-support gap | maximum known gap: static test/experiment reachability gap, plus exact-blob mutation gap (`1 - mutation score`) when a revision-bound mutation snapshot exists |
| `X` execution-exposure proxy | fraction of statically exported production entrypoints that can reach the unit |
| `C` change exposure | mean exponentially decayed `git blame` line recency within the callable, measured at the analyzed commit timestamp |

`E` and `X` are explicitly proxies in v1. Static reachability does not prove that a test exercises the relevant hostile case, and exported-entrypoint reachability is not production telemetry. They are quantitative placeholders that can be replaced by obligation-bound evidence and OpenTelemetry transaction observations while preserving the vector shape.

### Authority is configured; propagation is derived

Generic tooling cannot know which operations establish or interpret Overcenter truth. `config.json` therefore names the semantic authority sinks and their recovery classes. It does **not** assign importance to every function. Once the sinks are declared, influence is derived from the static call graph.

### Recovery criticality is graph-theoretic

For each configured recovery scenario `(entry, terminal)`, the analyzer computes call-graph dominators. A production unit contributes to `R` only when every statically resolved call path from the scenario entry to terminal passes through it.

## Total orders

The vector is durable data. Ordering is replaceable policy, and v2 deliberately exposes two different total orders instead of mixing consequence with uncertainty.

**Consequence criticality** asks: if this production unit is wrong, how much can it matter?

```text
consequence = Σ wi*vi + λAI*(A*I)
inputs      = A, B, I, F, R, X
```

**Engineering-attention priority** asks: where should we investigate next?

```text
attention = wc*consequence + wE*E + wC*C + λBE*(B*E)
```

Evidence gap `E` and change exposure `C` therefore cannot make code more consequential, and they cannot create attention from zero-consequence code. They only multiply the priority of code that already has measured consequence. Prior human ranking judgments calibrate the consequence order. Both scores are normalized to 0-100 only for presentation, and stable unit ID breaks ties.

The policies in `config.json` are expected to change. Changing either policy does not alter the measured vector.

## Calibration

The prior human ranking exercise is converted into pairwise regression judgments. The initial corpus includes the earlier ordering that placed:

1. DONE-candidate reuse above obligation/verifier identity;
2. obligation/verifier identity above settlement;
3. settlement above authoritative absence;
4. the verified predicate above authoritative absence;
5. execution fencing above durable effect reservation;
6. project-truth derivation above explanation/rendering; and
7. settlement above error-string plumbing.

A scoring policy is useful only if disagreements are inspectable. The analyzer reports every failed pair with both scores instead of silently fitting them away.

## Hostile cases

The self-test establishes that:

- `test/` and `experiments/` callables never enter the ranked population;
- a production helper beneath a settlement sink inherits settlement authority;
- test plus experiment support closes the v1 two-tier evidence-support gap;
- unsupported production code retains a full evidence-support gap; and
- calibration is evaluated from the generated scores, not hard-coded ranks.

The live repository run adds harder failure modes: unresolved dynamic calls, sibling authority paths, generated code, local helpers, and real git history.

## Run

The experiment pins TypeScript 5.8.3.

```sh
npm install --no-save --ignore-scripts typescript@5.8.3
node --test experiments/production-criticality-ranking/analyze.test.mjs
node experiments/production-criticality-ranking/analyze.mjs \
  --config experiments/production-criticality-ranking/config.json \
  --json /tmp/criticality.json \
  --markdown /tmp/criticality.md
```

The GitHub workflow runs the exact pull-request head with full history (`fetch-depth: 0`) because both the ranking and change exposure are revision-bound evidence. It requires every named **required** calibration regression to remain satisfied. The known callable-granularity mismatch is retained separately as a diagnostic pair, so one repaired diagnostic cannot mask a newly broken required judgment.

## Success criteria

The first experiment earns promotion only if:

1. the ranked population contains production callables and nothing else;
2. all configured authority and recovery selectors resolve exactly once;
3. internal static call resolution is high enough that the graph is informative; external/library calls are excluded from that denominator and unresolved internal/unknown calls are reported. Parameter-bound callbacks inside authority, recovery, or calibration callables fail closed unless the exact caller and parameter are declared in `graphQuality.criticalCallbackBoundaries`; those declarations are selector- and parameter-validated so stale exemptions fail closed;
4. every named required calibration regression remains satisfied, while known model mismatches remain explicit diagnostics;
5. surprising ranks can be decomposed into vector components and graph evidence; and
6. deleting every generated report and recomputing at the same revision produces the same result.

A required calibration regression is evidence against the formula or graph evidence and fails CI individually. A diagnostic disagreement is evidence about the callable-level model and remains visible without consuming a percentage budget. Neither is a reason to hand-edit ranks.

## First live-run lesson

The initial live run is intentionally allowed to falsify the model. In particular, calibration should not be forced to 100% by weight-tuning when one human judgment names a branch-level semantic claim that the callable-level population cannot represent. A monotone ranking cannot repair missing dimensions or the wrong unit boundary; those disagreements are evidence for the next experiment.


## Mutation probe

The callable ranking deliberately does not treat ordinary reachability as proof that hostile cases are defended. A separate targeted mutation probe uses StrykerJS 10.0.0 against the semantic regions that either rank unexpectedly high or anchor the calibration corpus:

- canonical digest construction;
- semantic identity;
- DONE-candidate realization reuse;
- durable effect reservation;
- settlement;
- exact execution-permit fencing; and
- verification / authoritative-absence predicates.

This is an independent validation layer, not another ranking coefficient. `mutation-probes.json` names production callables semantically; the resolver turns those selectors into exact revision-bound source ranges before Stryker runs, so ordinary line movement cannot silently retarget the probe. It mutates expressions and branches inside those regions and runs the focused semantic tests against every generated mutant. The result is reported per semantic region as killed, survived, uncovered, timeout/error, and mutation score.

A surviving mutant is useful evidence that the current `E` proxy overstates protection. A fully killed region is evidence that reachable tests actually distinguish at least the mutation operators Stryker generated there. Neither outcome changes the criticality score automatically; the purpose of this pass is to determine whether mutation evidence is stable enough to replace the v1 binary support proxy.

Run it with:

```sh
npm install --no-save --ignore-scripts @stryker-mutator/core@10.0.0
node --test experiments/production-criticality-ranking/summarize-mutation.test.mjs
npx stryker run experiments/production-criticality-ranking/stryker.config.mjs
node experiments/production-criticality-ranking/summarize-mutation.mjs mutation.json mutation-summary.md
```


## Mutation evidence outcome

The first exact-blob mutation run materially changed the interpretation of `E`.

Static reachability was too optimistic. The focused suite could reach every selected semantic region, yet Stryker still produced substantial surviving-mutant populations:

| Semantic region | Mutation score |
| --- | ---: |
| digest foundation | 100.0% |
| semantic identity | 10.9% |
| DONE-candidate reuse | 69.4% |
| effect reservation | 53.6% |
| settlement | 46.8% |
| execution fence | 50.0% |
| verification / authoritative absence | 34.3% |

Several survivors weaken claim-bearing conditions, not merely diagnostic strings. Examples include execution-generation/authority/capability conjunctions, lifecycle/run admissibility checks, rejection handling, settlement guards, and Kubernetes UID/resourceVersion verification.

The ranking therefore treats mutation evidence conservatively:

```text
reachability_gap = 1 - supported_static_tiers / required_static_tiers
mutation_gap     = 1 - mutation_score

E = max(reachability_gap, mutation_gap)
```

Mutation evidence is content-addressed by the exact Git blob identities of the production files it exercised. Matching bytes allow evidence reuse across later commits. If any bound blob changes, the affected probe becomes stale and contributes a full evidence gap (`E = 1`) until it is rerun. For authority sinks, recovery terminals, and calibration callables, **missing** hostile-case evidence is also a first-class evidence obligation and contributes `E = 1`; absence of evidence is never interpreted as a zero gap.

The checked-in snapshot is a cache of probe evidence, not an authority by itself. CI binds it to the cited successful mutation workflow, artifact digest, mutation-report digest, resolved semantic ranges, and the exact historical Git blobs at that revision. Freshness is a separate question: if current source bytes differ, the analyzer reports the probe as stale and assigns the affected callable a full evidence gap (`E = 1`) instead of treating staleness as a repository-wide merge veto.

This makes mutation output a durable evidence snapshot rather than a 27-minute dependency of every ranking run. The raw mutation score is intentionally conservative: diagnostic/equivalent mutants can overstate the gap, but surviving claim-bearing mutants show that the gap is real. A later experiment should distinguish claim-bearing mutants from diagnostic noise rather than pretending the raw percentage is exact.
