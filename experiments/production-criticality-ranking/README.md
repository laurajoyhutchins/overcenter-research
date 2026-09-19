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
| `E` evidence-support gap | `1 - supported evidence tiers / required evidence tiers`; v1 tiers are passing `test/` and `experiments/` call paths |
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

Evidence gap `E` and change exposure `C` therefore cannot make code more consequential; they can only increase attention. Prior human ranking judgments calibrate the consequence order. Both scores are normalized to 0-100 only for presentation, and stable unit ID breaks ties.

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
  --markdown /tmp/criticality.md \
  --min-calibration 0.8
```

The GitHub workflow runs the exact pull-request head with full history (`fetch-depth: 0`) because both the ranking and change exposure are revision-bound evidence. It requires at least 80% pairwise calibration agreement but still reports every disagreement.

## Success criteria

The first experiment earns promotion only if:

1. the ranked population contains production callables and nothing else;
2. all configured authority and recovery selectors resolve exactly once;
3. internal static call resolution is high enough that the graph is informative; external/library calls are excluded from that denominator and unresolved internal/unknown calls are reported;
4. the calibration corpus substantially agrees with the previous human ranking;
5. surprising ranks can be decomposed into vector components and graph evidence; and
6. deleting every generated report and recomputing at the same revision produces the same result.

A poor calibration result is evidence against the formula or the callable-level model, not a reason to hand-edit ranks.

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
