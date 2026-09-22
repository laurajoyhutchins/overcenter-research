# Code-graph verification frontier experiment

## Question

Can a mechanically derived static code graph predict the verification consequences of real code changes well enough to eliminate most irrelevant test execution without missing regressions?

The first subject is `pallets/flask`. Flask is small enough to rebuild the graph cheaply, but its decorators, fixtures, callbacks, nested functions, and dynamic application structure are hostile enough that a naive static graph can fail for interesting reasons.

## Hypothesis

For admitted real Flask changes, a deterministic graph frontier can retain at least **99% recall** over tests whose outcomes change while selecting at most **30% of the verification universe**, with **zero missed regressions** among tests that passed before the patch.

The experiment is falsified if any of these preregistered conditions fails:

1. pooled affected-test recall is below 0.99;
2. the selected-test fraction is above 0.30; or
3. any previously passing test becomes non-passing outside the predicted frontier.

Precision and wall-clock reduction are reported but are not gates. Authorship is a preregistered stratum, not a different hypothesis.

## Why this corpus

Each runnable case binds one exact Flask base commit to both a human-authored patch and an independently published AI-authored patch. The initial two cases are plumbing controls:

- `pallets__flask-4045`: human patch from Flask history and the final Loope AI patch.
- `pallets__flask-5014`: human patch from Flask history and the `dm-agent-deepseek` patch published by DM-Code-Agent.

For both initial cases the successful AI production patch is byte-equivalent in meaning to the human production patch. That is useful as an authorship control, but it does **not** provide patch-shape diversity. Identical `(base_commit, patch bytes)` pairs must be deduplicated for primary graph-performance statistics.

A documented `gpt-oss:120b` Flask-5014 run is also recorded because it fixed the target test while regressing 44 previously passing tests. It is excluded from primary statistics until the exact patch bytes are pinned. Outcome tables are not a substitute for an executable patch artifact.

### Confirmatory-corpus admission

No broad conclusion is allowed from the two-case pilot. A confirmatory run requires, before looking at aggregate results:

- all usable Flask instances in the selected SWE-bench slice to be enumerated;
- at least 10 exact human patches and 10 exact AI patches;
- at least 5 AI patches whose bytes differ from the corresponding human patch; and
- at least 2 exact unsuccessful or regressive AI patches.

If those conditions cannot be met, the result remains a pilot rather than being promoted by relaxing the corpus after inspection.

## Representation

Version 1 intentionally uses only Python's standard-library AST. It does not use an LLM.

```text
patch hunks
    |
    v
changed source symbols
    |
    v
static name/call graph
    ^
    |
test functions
    |
    v
tests that can reach a changed symbol
```

Nodes are modules, classes, functions, methods, and test functions. Calls resolve conservatively by simple symbol name; attribute calls such as `obj.method()` may therefore fan out to every statically known `method`. Calling a class also reaches its `__init__`. This bias intentionally spends precision to protect recall.

Known hard cases remain visible rather than silently guessed: unresolved calls, parse failures, reflection, dynamic registration, monkeypatching, import-time behavior, and framework-generated behavior.

## Blind protocol

The predictor must run before either patched test result is inspected.

For one case and variant:

```sh
python3 experiments/code-graph-verification/prepare.py \
  --flask-repo /path/to/flask \
  --case pallets__flask-5014 \
  --variant human-gold \
  --out /tmp/cgv-5014-human
```

`prepare.py` creates two detached worktrees at the exact base commit, applies the same held-out test patch to both, applies the candidate production patch only to `patched/`, then computes `frontier.json` from the base tree and candidate diff.

Run the **same full pytest command in the same environment** in both worktrees and emit JUnit XML:

```text
base/     -> base.xml
patched/  -> patched.xml
```

Then score:

```sh
python3 experiments/code-graph-verification/score.py \
  --frontier /tmp/cgv-5014-human/frontier.json \
  --base-junit /tmp/cgv-5014-human/base.xml \
  --patched-junit /tmp/cgv-5014-human/patched.xml \
  --out /tmp/cgv-5014-human/score.json
```

An affected test is defined mechanically as a test whose normalized outcome differs between the base and patched runs. A regression is a test that passes in the base run and does not pass in the patched run.

The exact test environment is evidence. Before a run is admitted to the confirmatory corpus, record an immutable container/environment identity alongside the result. A mutable image tag or an unrecorded local environment is exploratory only.

## Metrics

For predicted frontier `P`, affected tests `A`, and verification universe `U`:

```text
recall            = |P ∩ A| / |A|
precision         = |P ∩ A| / |P|
selected_fraction = |P| / |U|
reduction         = 1 - selected_fraction
```

Parameterized pytest cases are normalized to their static test function for comparison with the AST graph.

Report the pooled result, each issue, and the human/AI strata. Do not use the authorship split to rescue a failed pooled result.

## Reproduction contract

The cheap repository contract is deterministic and dependency-free:

```sh
npm run test:code-graph-verification
```

It checks the corpus schema and runs a synthetic negative control where only one of two tests reaches the changed function. The real Flask corpus is intentionally not part of ordinary CI because cloning external history and running full historical test environments is expensive and host-dependent.

## Interpretation

A positive confirmatory result would support a narrow claim: static reachability is good enough to prune a large fraction of verification work for the admitted Flask change distribution.

It would not prove that:

- the same threshold holds for other languages or repositories;
- static reachability establishes semantic correctness;
- dynamic edges are absent;
- AI changes are inherently safer or riskier than human changes;
- selected tests may replace full verification without an independently justified operating policy; or
- the current AST graph should become Overcenter authority.

A negative result is useful. Missed affected tests identify concrete missing graph relations; poor reduction shows that the representation is too coarse even if it is safe.
