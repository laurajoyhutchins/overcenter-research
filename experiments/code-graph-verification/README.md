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

## Confirmatory corpus

The confirmatory slice is fixed to every `repo=pallets/flask` row in the full SWE-bench test split. The source fixture contains exactly 11 instances:

```text
pallets__flask-4045
pallets__flask-4074
pallets__flask-4160
pallets__flask-4169
pallets__flask-4544
pallets__flask-4575
pallets__flask-4642
pallets__flask-4935
pallets__flask-4992
pallets__flask-5014
pallets__flask-5063
```

For all 11, `corpus.json` pins the exact base commit, gold production patch, and held-out test patch from the published SWE-bench Flask fixture.

The candidate AI stratum currently contains 10 exact patch artifacts from four independent public sources:

- Loope for Flask 4045;
- DM-Code-Agent for Flask 5014;
- SWE-benchify Claude Opus, Haiku, and Sonnet outputs for Flask 4045 and 4074; and
- the lightweight-code-agent failure corpus's Qwen 2.5 Coder 32B direct outputs for Flask 4992 and 5063.

The latter two are intentionally adversarial. Their published SWE-bench harness reports record:

- Flask 4992: target still failing, plus **2 previously passing tests failing**;
- Flask 5063: both target tests still failing, plus **54 previously passing tests failing**.

Those are useful because a verification frontier that only works on correct or gold-like patches is not useful enough.

Variants in the same `equivalence_group` are deduplicated for primary graph-performance statistics. Different authorship labels or model runs do not increase the effective sample size when they induce the same graph-relevant edit.

A documented `gpt-oss:120b` Flask-5014 run remains outside the primary corpus even though its published outcome reports 44 regressions. Its exact patch bytes are not pinned, and an outcome table is not a substitute for an executable artifact.

### Admission state

The preregistered artifact-count gates are:

- at least 10 exact human patches;
- at least 10 exact AI patches;
- at least 5 AI patches whose bytes differ from the corresponding human patch; and
- at least 2 exact unsuccessful or regressive AI patches.

The frozen corpus satisfies the artifact gates and exact-base hosted preflight. Execution admission is recorded below.

Before a variant enters confirmatory statistics:

1. its held-out test patch must apply exactly to the declared base commit;
2. its candidate production patch must pass ordinary `git apply --check` at that base;
3. no fuzzy patching, manual repair, or context reinterpretation is allowed;
4. the graph frontier must be generated before patched test outcomes are inspected; and
5. the test environment must be recorded by immutable identity.

A candidate that fails exact application is excluded from the executable corpus and reported as such. It is not silently repaired to make the experiment easier.

### Hosted preflight evidence

The frozen corpus passed exact-base hosted preflight in GitHub Actions run `35692172396` at revision `f236cb5c155d7258d75f6b4277aee6c0739ddc0d`.

The content-bound evidence snapshot records:

```text
corpus sha256:      ab603d5839bf8d76eb5b1836612cf2200f1cb2ea0d232cfd1a32aa13aa2fc53e
human exact apply:  11
AI exact apply:     10
AI nonidentical:    10
adversarial AI:     4
execution admission: true
```

`contract.test.mjs` recomputes the current corpus digest and rejects this evidence snapshot if the corpus bytes change.

## Representation

The predictor uses only Python's standard-library AST and deterministic relations. It does not use an LLM.

The historical v1 used broad simple-name resolution. After v1 was falsified, the repaired representation added decorator spans, qualified/import-aware and re-export resolution, explicit Click dispatch edges, patched syntax/import blast-radius handling, and a bounded low-ambiguity attribute fallback.

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
  --environment-id sha256:<immutable-container-or-environment-digest> \
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

It checks the fixed 11-case slice, artifact-count admission, patch-file presence, adversarial outcome provenance, thresholds, and a synthetic negative control where only one of two tests reaches the changed function.

The experiment lifecycle is also software-owned:

```sh
npm run experiment:code-graph-preflight -- \
  --flask-repo /path/to/flask \
  --out /tmp/code-graph-preflight.json \
  --require-admission

# prepare + execute + score every admitted variant into one results root

npm run experiment:code-graph-summarize -- \
  --results /tmp/code-graph-results \
  --preflight /tmp/code-graph-preflight.json \
  --out /tmp/code-graph-summary.json
```

Preflight performs exact-base `git apply --check`, rejects candidate patches that modify the held-out test namespace, and computes execution-admitted corpus counts. The summarizer requires the result set to match preflight exactly, validates declared equivalence groups, performs all pooled arithmetic, and evaluates the preregistered gates.

The real historical Flask executions are intentionally separate from ordinary fast CI. Their immutable environment identity and full result artifacts are evidence, not ambient developer state.

### Hosted confirmatory execution

`.github/workflows/code-graph-verification-confirmatory.yml` is manual-only. It resolves each official SWE-bench instance image to an immutable Docker RepoDigest, verifies the image's `/testbed` commit against `corpus.json`, runs one held-out-test base suite per Flask case, then runs every candidate variant for that case with container networking disabled.

The 11 cases fan out in parallel. Base outcomes are reused within each case, reducing the full-suite oracle workload from 42 runs to 32. Each container is reset to the exact benchmark base commit while retaining its immutable dependency environment. The aggregation job accepts results only when they match exact preflight admission and lets `summarize.py` evaluate the preregistered gates.

Once immutable JUnit outcomes exist, graph mechanics can be iterated without rerunning pytest:

```sh
npm run experiment:code-graph-replay-frontiers -- \
  --flask-repo /path/to/flask \
  --results /path/to/preserved/results

npm run experiment:code-graph-rescore -- \
  --results /path/to/preserved/results
```

## Confirmatory result — 2026-09-22

The corrected v1 result is still **falsified**:

```text
affected-test recall: 0.924282   (required >= 0.99)
selected fraction:    0.617214   (required <= 0.30)
missed regressions:   26         (required 0)
precision:            0.083668
reduction:            0.382786
```

A scoring audit found that AST class-test IDs used `Class.test` while pytest JUnit used `Class::test`. Immutable evidence was rescored after canonicalizing that coordinate. The correction changes the magnitude, not the conclusion: all three v1 gates still fail.

### Repaired calibration replay

The deterministic repair derived from those failures was replayed against the same preserved oracle outcomes:

```text
affected-test recall: 1.000000
selected fraction:    0.231072
missed regressions:   0
precision:            0.241793
reduction:            0.768928
```

So every previously observed affected test is now selected while remaining below the frozen 30% ceiling. This is deliberately labeled **post-hoc calibration**, not independent confirmation, because the representation was changed after observing this corpus.

Evidence is recorded in `results/2026-09-22-confirmatory.*` and `results/2026-09-22-repaired-replay.*`. The next falsification must use a fresh holdout without first changing the repaired representation.

## Interpretation

A positive confirmatory result would support a narrow claim: static reachability is good enough to prune a large fraction of verification work for the admitted Flask change distribution.

It would not prove that:

- the same threshold holds for other languages or repositories;
- static reachability establishes semantic correctness;
- dynamic edges are absent;
- AI changes are inherently safer or riskier than human changes;
- selected tests may replace full verification without an independently justified operating policy; or
- the current AST graph should become Overcenter authority.

Artifact-count completion alone is not evidence for the hypothesis. A negative execution result is useful: missed affected tests identify concrete missing graph relations, while poor reduction shows that the representation is too coarse even if it remains safe.
