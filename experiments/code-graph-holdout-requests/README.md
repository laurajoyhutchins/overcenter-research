# Requests independent code-graph holdout

## Status: invalidated

This attempted holdout is **not scientific evidence about graph recall**.

The frozen graph was configured with `test_roots=["tests"]`, but these historical Requests revisions keep their test suite in root-level `test_requests.py`. The graph therefore discovered zero tests and selected zero tests for every variant. This configuration defect was only discovered after oracle outcomes existed, so Requests is contaminated and cannot be repaired and reused as independent confirmation.

GitHub Actions run `35744157408` is retained as diagnostic evidence only. Its apparent pooled metrics (0% recall, 0% selected) must not be interpreted as a graph result.

The failure changed experiment admission: every future holdout must prove a nonzero graph-discovered test universe at every exact base revision before oracle execution. The fresh Pylint holdout implements that invariant.

## Original purpose

This was intended as the fresh holdout for the repaired deterministic verification-frontier representation developed after the Flask calibration experiment.

## Frozen representation

The experiment pins the exact Git blobs for:

- `experiments/code-graph-verification/frontier.py`: `d504fbdc575d520cb2360cf223eb5ff960db8e98`
- `experiments/code-graph-verification/score.py`: `3fc6acb019c4dada4eea3972abd3736303ac9502`

The graph includes decorator spans, qualified/import-aware resolution, package re-export resolution, Click literal-dispatch edges, patched syntax/import blast-radius expansion, and bounded unresolved attribute fanout of at most three internal definitions.

If either pinned blob changes, preflight refuses execution.

## Holdout selection

The subject is `psf/requests`.

Selection is mechanical and outcome-blind:

1. enumerate every `psf__requests-*` directory in IBM Issue-Test-Localizer's `verified_gpt4o_all_unique_patches` corpus;
2. take exactly `dedup_patch_0.jsonl` from every directory;
3. pair it with the corresponding SWE-bench human gold patch and held-out test patch; and
4. require exact application and production-only candidate edits.

This yields eight independent Requests issues, 8 human changes, and 8 AI Agentless changes. No model success/failure metadata is stored in the corpus or used for selection.

## Frozen gates

The same gates used for Flask apply unchanged:

```text
affected-test recall >= 0.99
selected fraction    <= 0.30
missed regressions   == 0
```

The pooled result is authoritative. Human and AI strata are reported but cannot rescue a failed pooled result.

## Execution

The oracle uses the official SWE-bench image for each instance by immutable RepoDigest. Each fresh container resets `/testbed` to the declared benchmark base, applies the held-out tests, then applies exactly one candidate patch. Network access is disabled during pytest.

One base suite is reused for the two variants in each issue, so the eight-case holdout requires 8 base suites + 16 patched suites = 24 full-suite executions.

The graph frontier is generated before the patched test outcome is inspected.

## Interpretation

No pass/fail claim is permitted from this corpus.

The useful result is methodological: exact patch application and frozen graph identity are insufficient admission criteria. Test discovery itself must be validated before any verification-frontier experiment can be meaningful.

Requests is permanently excluded from independent confirmation for this representation because its oracle outcomes have now been observed.
