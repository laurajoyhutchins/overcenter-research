# Experiments

Only maintained executable research lives in this tree. Git history is the archive for retired experiments; old experiment prose, result snapshots, and registry records are not carried forward once their useful conclusions have either graduated into production machinery or been rejected.

`experiments/registry.json` catalogs the maintained set. It is an explainability aid, not project authority or a merge-gate input.

## Maintained experiments

- `adapter-diagnosability` (supported) — Can a finite-state DES-style checker determine whether mutation occurrence is eventually distinguishable from non-occurrence, and whether that distinction is available before authority reuse?
- `adapter-uncertainty-exploration` (falsified) — Does Overcenter's current durable GitHub commit-status state vocabulary preserve every distinction that matters to retry safety across uncertainty at the provider boundary?
- `assignment-capsule` (supported) — Can Overcenter claim real work and deliver a self-contained byte-complete assignment to an empty disposable worker?
- `authority-flow-analysis` (supported) — Can a small static abstract interpreter reject mutation paths where untrusted agent data, exact revision identity, or current execution authority cross a trust boundary incorrectly, while accepting the real GitHub mutation paths without per-path suppressions?
- `authority-storage-decomposition` (supported) — Can Overcenter factor durable project authority into immutable content-addressed fact objects plus a separately linearizable authority-head CAS without changing project semantics?
- `codex-closed-loop` (pending) — Can Overcenter delegate implementation judgment to a disposable Codex worker while retaining claim, verification, settlement, publication, and readback authority outside the worker?
- `core-loop-concurrency` (supported) — Does the production runCoreLoop bounded-concurrency path recover useful parallel throughput while one kernel retains all execution authority and settlement responsibility?
- `disposable-agent` (supported) — Can a fresh worker recover after the original worker disappears?
- `distributed-authority-chaos` (supported) — Does the Postgres-free remote-CAS authority architecture survive repeated controller turnover, concurrent unrelated authority updates, unresolved-effect handoff, and repeated execution-authority rotation rather than only one staged transaction?
- `distributed-authority-handoff` (supported) — Can independent disposable controllers share authoritative Overcenter project truth without a shared application database by using immutable Git facts plus one remote exact-head CAS coordinate?
- `effect-authority-decay` (supported) — Once execution authority is established, can Overcenter preserve it through the trusted GitHub effect broker instead of repeatedly decomposing it into raw identifiers and reconstructing the same relationship at each provider?
- `github-object-transport` (supported) — Can a worker receive exactly declared GitHub bytes without a checkout or repository credential?
- `github-observation-grammar` (supported) — Can GitHub read semantics use a schema-derived observation grammar plus explicit semantic projections?
- `github-status-not-dispatched-release` (supported) — Can trusted fresh-socket NOT_DISPATCHED evidence release exactly one GitHub commit-status reservation without weakening no-blind-replay?
- `kubernetes-configmap-effect` (supported) — Can a second provider mutation use the existing semantic-intent, exact claim/fence, durable effect reservation, Kubernetes observation, and settlement machinery without introducing Kubernetes-shaped kernel logic?
- `production-criticality-ranking` (mixed) — Can Overcenter maintain a reproducible total ordering of production-code importance from quantitative facts?
- `production-latency` (supported) — For one successful production GitHub status transaction, how much latency belongs to Overcenter local correctness machinery versus provider I/O?
- `scheduler-liveness` (supported) — Under explicit availability and observation assumptions, does scheduler selection guarantee progress for a continuously eligible recovered obligation, and where does the current fresh-first policy cease to be starvation-free?
- `scheduler-policy-comparison` (supported) — Which deterministic replay-derived scheduler policy survives recovered-target fresh floods, fresh-target recovery pressure, and adversarial same-class arrivals without adding a mutable scheduler cursor?
- `source-obligation-integration` (supported) — Can source-development work retain stable obligation identity while exact Git revisions remain claim-time execution fencing, so independent work can integrate without encoding pull-request stack topology into the graph?
- `substrate-capability-admission` (supported) — Can signed, context-bound substrate capability evidence safely affect admission for one exact provider capability without trusting environment declarations?
- `transport-not-dispatched-evidence` (supported) — Can a trusted HTTPS transport boundary produce a NOT_DISPATCHED witness strong enough to distinguish definitely-not-dispatched mutation from an uncertain mutation outcome?
- `typed-capability-authority` (supported) — Can Rust preserve the current GitHub commit-status mutation admission semantics while making weaker authority impossible to pass to the effect primitive through safe code without materially reducing local admission performance?
- `verified-generated-output` (supported) — Can trusted validation establish authoritative identity for generated artifact bytes that were not known when the obligation was defined, while downstream work consumes only retained evidence and an authoritative settlement receipt?

## Evidence rules

- Freeze material design before outcome-bearing execution when a claim is confirmatory.
- Bind hosted evidence to an exact Git revision and preserve only evidence still needed by a live claim.
- Promote durable correctness properties into `src/`, `test/`, or `formal/`; do not keep a second historical implementation alive in `experiments/`.
- A falsified hypothesis is a valid result. Once its design lesson is captured by current machinery or Git history, retire the working-tree scaffolding.

## Statistical evidence

`npm run check:experiment-statistics` enforces the statistical contract for maintained claims that require sampled uncertainty. Deterministic and exhaustive claims should report their bounded corpus or state space instead of manufacturing confidence intervals.

Hosted proofs remain thin workflows under `.github/workflows/` and invoke the maintained experiment or production proof they exercise.
