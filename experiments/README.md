# Experiments

This directory contains executable empirical and adversarial proofs. An experiment is not a second implementation layer: it is a bounded scenario that exercises the reusable mechanism under a specific hostile or failure condition.

Each experiment owns the actors, fixtures, and local proof tests that change together. GitHub Actions workflows remain under `.github/workflows/` because GitHub requires that location, but those workflows should stay thin and invoke code from the corresponding experiment directory.

- `sqlite-baseline/` — original SQLite-backed reference baseline.
- `disposable-agent/` — worker destruction, reconstruction, and settlement.
- `two-effect-concurrency/` — independent effects executing and recovering concurrently.
- `conflicting-effect/` — canonical effect-coordinate conflict and commutativity behavior.
- `github-object-transport/` — exact GitHub object materialization fixtures.
- `git-stress/` — adversarial Git/CAS/clone stress coverage.

Reusable mechanism belongs in `src/`. Focused mechanism tests belong in `test/`. Literature and synthesis belong in `research/`.
