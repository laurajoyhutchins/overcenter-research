# Pylint independent code-graph holdout

## Purpose

This is the fresh independent holdout for the repaired deterministic verification-frontier representation produced by the Flask calibration experiment.

The earlier Requests attempt is explicitly excluded from independent evidence. It revealed that historical Requests tests lived outside the preregistered `tests/` root only after oracle outcomes were observed. That was an admission-design defect, not a graph result, and it contaminated Requests for future confirmation.

## Frozen representation

The exact graph and scorer blobs are pinned before Pylint outcomes:

```text
frontier.py  d504fbdc575d520cb2360cf223eb5ff960db8e98
score.py     3fc6acb019c4dada4eea3972abd3736303ac9502
```

The representation includes decorator spans, qualified/import-aware resolution, exact package re-export resolution, Click literal-dispatch edges, patched syntax/import blast-radius expansion, and bounded unresolved attribute fanout of at most three internal definitions.

If either blob changes, preflight fails closed.

## Holdout selection

Selection is mechanical and outcome-blind.

1. enumerate all `pylint-dev__pylint-*` directories in IBM Issue-Test-Localizer's `verified_gpt4o_all_unique_patches` corpus;
2. intersect them with Pylint task directories in Xingkai98/asterwynd that publish exact `gold.patch` and `test.patch`;
3. take exactly `dedup_patch_0.jsonl` from IBM for each intersecting issue; and
4. reject any candidate patch that modifies the held-out test namespace.

The intersection contains eight issues: 4551, 4604, 4661, 4970, 6386, 6528, 6903, and 7080. That yields 8 human gold changes and 8 AI Agentless changes.

No model success/failure metadata is stored in the corpus or used for selection.

## Admission invariant added after Requests

Exact patch application is not enough. Before Pylint can execute, the **frozen graph itself must discover a nonzero test universe at every exact historical base** using the preregistered roots:

```text
source root: pylint/
test root:   tests/
```

This prevents a wrong test-root configuration from producing a superficially valid but scientifically meaningless zero-frontier experiment.

## Frozen gates

The same gates remain unchanged:

```text
affected-test recall >= 0.99
selected fraction    <= 0.30
missed regressions   == 0
```

The pooled result is authoritative. Human and AI strata are reported but cannot rescue a failed pooled result.

## Execution

Each official SWE-bench image is resolved to an immutable RepoDigest. A fresh container resets `/testbed` to the declared base, applies the held-out test patch, then applies one candidate patch. Network access is disabled during pytest.

One base suite is reused for both variants in each issue:

```text
8 base suites + 16 patched suites = 24 full-suite oracle executions
```

The frontier is computed before the patched test outcome is inspected.

## Interpretation

A pass is independent evidence that the repaired deterministic representation generalizes beyond the Flask corpus that produced it.

A failure must be preserved as evidence. Any representation repair based on Pylint failures turns Pylint into calibration and requires another fresh holdout.
