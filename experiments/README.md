# Experiments

This directory contains bounded executable proofs. An experiment is evidence about a specific failure mode or architectural claim, not a second implementation layer.

Each experiment owns the actors, fixtures, and focused tests that change together. GitHub requires workflow YAML under `.github/workflows/`, so those files remain there but should stay thin and invoke the corresponding experiment.

- `sqlite-baseline/` — original SQLite-backed baseline.
- `disposable-agent/` — disposable worker handoff and reconstruction.
- `two-effect-concurrency/` — independent concurrent effects and recovery.
- `conflicting-effect/` — effect-coordinate conflict and commutativity.
- `eventually-consistent-readback/` — hostile stale/negative provider readback.
- `github-observation-grammar/` — generated GitHub observation vocabulary and live ref proof.
- `github-object-transport/` — exact GitHub object transport fixtures.
- `git-stress/` — adversarial Git/CAS/clone stress coverage.

Reusable mechanism belongs in `src/`. Focused mechanism invariants belong in `test/`. Machine-checked models belong in `formal/`. Literature and synthesis belong in `research/`.
