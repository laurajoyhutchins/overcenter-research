# Confirmatory result — 2026-09-22

The preregistered v1 hypothesis was **falsified** on the frozen Flask corpus.

| Metric | Gate | Observed |
| --- | ---: | ---: |
| Affected-test recall | >= 0.99 | 0.851175 |
| Selected fraction | <= 0.30 | 0.569511 |
| Missed regressions | 0 | 50 |
| Precision | report only | 0.083504 |
| Verification reduction | report only | 0.430489 |

The pooled result contains 21 raw variant runs and 19 effective observations after equivalence-group deduplication. Across 6,855 observation-level test outcomes, 383 changed, 326 were inside the predicted frontier, 57 were missed, 357 were regressions, and 50 regressions fell outside the frontier.

## Execution evidence

The complete corrected run is GitHub Actions run `35693710320` at execution revision `1aaeadeccbfb6f78a0f317960ffa8ccc98c126f6`. Summary artifact `10678913301` has SHA-256 `41d5ba0cc8027885699cf57013211d84bc92120f1af7241f172bc441fd83ae54`.

A second aggregation path, run `35693741253`, reused the ten successful prior shards and reran only Flask 5063. It reproduced the pooled metrics and gates exactly. Its summary artifact is `10679815533`, SHA-256 `6ebf1be1e7e9a11ad3d4614f2af66f7b095c6e8b6fe5e8517aa9230de862d8da`.

Two earlier runs are infrastructure history, not observations: run `35693066664` incorrectly treated image HEAD as source authority, and run `35693434810` incorrectly treated a candidate-induced pytest collection abort as a harness failure. Neither produced a pooled verdict.

## What failed

Three failures are especially informative.

**Flask 4544, human gold:** the only affected test, `tests/test_cli.py::test_run_cert_path`, was missed. The source edit adds `is_eager=True` to a `click.option` decorator, but v1 maps that changed decorator line to `src/flask/cli.py::<module>` rather than to the decorated command. This is a deterministic changed-symbol attribution defect.

**Flask 5063, human gold:** both new route-display tests were missed and the frontier was empty. The changed symbol is `routes_command`, but the tests reach it through Click registration and `runner.invoke(..., ["routes"])`, not an ordinary Python call edge. This requires framework registration/dispatch edges.

**Flask 5063, Qwen 32B direct:** the patch is syntactically invalid, so importing Flask aborts pytest collection. That changes 362 test outcomes, including 355 regressions. The frontier caught 308 but missed 54 affected tests and 50 regressions. A base-tree callable graph does not represent parse/import blast radius.

The opposite extreme also appears. Flask 4992's adversarial Qwen patch had two regressions; v1 caught both while selecting only 3 of 364 tests. Static reachability can be excellent when the dependency is local and explicit.

## What this says about v1

The problem is two-sided. The graph is under-connected around decorators, framework dispatch, and import-time failure, yet over-connected in ordinary code because simple-name call resolution fans out aggressively. Several correct cases selected roughly 82–86% of the suite, so fixing recall alone would not satisfy the 30% selection gate.

The next deterministic representation should therefore:

1. include decorator spans when assigning changed symbols;
2. model Click/Flask registration and command dispatch;
3. compile/parse patched modules before frontier selection and expand through import dependencies when a module cannot load;
4. replace simple-name fanout with qualified, import-aware resolution; and
5. rerun the **same frozen corpus and thresholds**.

No inference layer is justified by these misses yet. Each observed failure has a concrete deterministic representation path to test first.

## Immutable environments

- `pallets__flask-4045`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4045@sha256:1425b0801ddf4b2607e552e56516cce3d389bab0a3ce06f58e6fa6a7835c703c`
- `pallets__flask-4074`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4074@sha256:1e3045bfde746fc8de1b23b8320cdbe2e863bb93cb379ab1d662b508a367b313`
- `pallets__flask-4160`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4160@sha256:9d2640d4752dd0afc6a300e49d0bb6bc46524f5ea94c777457c5fbb2630ecb62`
- `pallets__flask-4169`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4169@sha256:ca90fa0d2d33ad6b6a8049fb3a24cae651c195e79184b1a969e0340fb47d8a39`
- `pallets__flask-4544`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4544@sha256:3fd9a96e1cfe8dc7b38777859fa8c65a19bc8c058867851a3dae4a886d33b47e`
- `pallets__flask-4575`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4575@sha256:48e7b711cb511fae4f8dd5e16185970a3c0157a3ebb77b48580cd0eb158e284c`
- `pallets__flask-4642`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4642@sha256:4fb3f5843fd36d1c3032bbe2a529be4bfc53a769813e4691f47c0ad3b5810df2`
- `pallets__flask-4935`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4935@sha256:193fc57b6093440e008ab8cdb8b0d8d2adbeddf88ced88199fe993f0f45214d6`
- `pallets__flask-4992`: `swebench/sweb.eval.x86_64.pallets_1776_flask-4992@sha256:bb1460876a7bc667f71b46aac744dd6f6d7f5f66e79902461cf76c6f8c4f7150`
- `pallets__flask-5014`: `swebench/sweb.eval.x86_64.pallets_1776_flask-5014@sha256:bde4fbdafa36141d4396944da88ec37aabdef612ed36920090675bccd0ca5d72`
- `pallets__flask-5063`: `swebench/sweb.eval.x86_64.pallets_1776_flask-5063@sha256:05369549db34553599f6f96d65ee9c75173c02d9285d283422f6b6e49f0b8df2`
