# Pylint independent code-graph holdout

This is the replacement independent holdout after the first Requests attempt was invalidated by a test-root setup error.

## Independence

The deterministic representation and scorer are frozen by exact Git blob identity before Pylint outcomes are inspected:

- frontier: `d504fbdc575d520cb2360cf223eb5ff960db8e98`
- scorer: `3fc6acb019c4dada4eea3972abd3736303ac9502`

No graph change is permitted on this corpus before the first valid pooled verdict.

## Corpus

The corpus is every `pylint-dev__pylint-*` directory in IBM Issue-Test-Localizer's `verified_gpt4o_all_unique_patches` collection: exactly 10 issues.

For each issue:

1. human production patch = SWE-bench task `gold.patch`;
2. held-out verification patch = SWE-bench task `test.patch`;
3. AI production patch = exactly `dedup_patch_0.jsonl`; and
4. model outcome reports are not consulted for admission or selection.

This creates 10 human and 10 AI Agentless changes.

## Admission

Before any oracle execution, preflight requires:

- exact graph and scorer blobs;
- exact base commit availability;
- exact held-out test-patch application;
- exact candidate patch application;
- no candidate modification of `tests/`;
- all AI patches byte-different from their corresponding gold patch; and
- **at least one graph-visible static test node in every case**.

That last invariant exists because the discarded Requests attempt exposed a bad test-root adapter before a valid holdout verdict could be produced.

## Frozen gates

```text
affected-test recall >= 0.99
selected fraction    <= 0.30
missed regressions   == 0
```

Human and AI strata are reported separately, but the pooled result decides the hypothesis.

## Oracle

The official SWE-bench image is resolved to an immutable RepoDigest. Each fresh container resets `/testbed` to the exact benchmark base and runs with network disabled.

Ten base suites are reused across twenty candidate variants: **30 full-suite executions** total.

A pass is independent evidence that the repaired deterministic representation generalizes beyond Flask. A fail remains a fail; any Pylint-informed repair becomes calibration and must be tested on another fresh holdout.
