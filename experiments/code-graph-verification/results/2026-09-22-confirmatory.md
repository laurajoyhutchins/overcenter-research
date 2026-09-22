# Confirmatory result — 2026-09-22

The preregistered v1 hypothesis was **falsified** on the frozen Flask corpus.

A later scoring audit found a coordinate mismatch between AST class-test IDs (`Class.test`) and pytest JUnit IDs (`Class::test`). The immutable JUnit/frontier artifacts were rescored after fixing normalization. The corrected result is:

| Metric | Gate | Corrected v1 |
| --- | ---: | ---: |
| Affected-test recall | >= 0.99 | 0.924282 |
| Selected fraction | <= 0.30 | 0.617214 |
| Missed regressions | 0 | 26 |
| Precision | report only | 0.083668 |
| Verification reduction | report only | 0.382786 |

All three preregistered gates still fail.

The corrected pooled result contains 21 raw variant runs and 19 effective observations. Across 6,855 observation-level test outcomes, 383 changed, 354 were inside the predicted frontier, 29 were missed, 357 were regressions, and 26 regressions fell outside the frontier.

## Evidence coordinates

The oracle execution remains GitHub Actions run `35693710320`.

The corrected scoring replay is run `35740676637`, job `106789316548`, artifact `10699258109`, SHA-256 `d9b3557bd1a8a64834d104c4c0e71cdb5dcb760949a0e2704c0a9c97bc877d6c`.

The scorer fix is commit `78810bb4be337d22dd98e31c670fa68af9cee1b7`.

## Interpretation

The scoring correction changes the magnitude but not the conclusion. v1 remains both insufficiently safe and far too broad. The original negative evidence therefore remains valid, but these corrected values supersede the earlier 85.12% / 56.95% / 50 figures.

The observed misses motivated deterministic representation repair rather than inference.
