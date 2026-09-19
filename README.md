# Overcenter Research

Overcenter asks a narrow question:

> How little trusted mechanism is required to turn uncertain agent activity into verified project truth?

This repository is an executable research prototype for that question. It is not a production orchestrator.

The core loop is:

```text
inspect authoritative facts
        ↓
derive READY work
        ↓
claim @ exact revision
        ↓
reserve effect durably
        ↓
execute uncertain action
        ↓
observe authoritative reality
        ↓
verify exact postcondition
        ↓
settle durable evidence
        ↓
recompute project projection ↺
```

The worker does not decide that its work succeeded.

## Current production slice

The supported runtime boundary is intentionally smaller than the research surface:

| Concern | Current owner | Status |
| --- | --- | --- |
| durable authority, graph semantics, claim/recovery fencing, observation, settlement | TypeScript + SQLite | production reference path |
| isolated replay-safe pure computation and attempt evidence | Go | admitted for the `test` workload |
| worker filesystem/process confinement | Rust | experiment only |
| Lean, Datalog, F*, bounded model checks | proof/differential oracles | no runtime authority |

The production computation profile is fail-closed:

```text
SQLite authority
      |
 exact READY claim + generation
      |
 trusted execution-context digest
      |
 Unix socket hello attestation
      |
 Go executor
      |
 UID/GID-isolated task
      |
 attempt evidence
      |
 confined TypeScript observation
      |
 settlement
```

The executor container runs without network access, with a read-only root/source snapshot, `no-new-privileges`, an explicit minimal capability set, PID/memory/CPU/open-file/per-file-size ceilings, and a fresh writable workspace. Aggregate workspace exhaustion belongs to the disposable outer worker-host quota rather than being delegated to the task container.

Run the same supported-slice proof used by CI:

```sh
npm run proof:production
```


## What is Overcenter?

Overcenter separates reasoning from execution correctness.

```text
reasoning worker
  judgment, synthesis, candidate action
             │
             ▼
deterministic kernel
  identity, fencing, observation,
  verification, recovery, settlement
             │
             ▼
authoritative project truth
```

The production authority store is SQLite: immutable fact-commit rows plus one compare-and-swap authority head, committed atomically in a local transaction. Git implements the same durable-fact contract as a reference and independent replay backend; project semantics do not depend on Git. Direct migration of an existing history between backends is a separate problem because some durable facts intentionally bind backend-local authority identities.

Project state such as `READY`, `EXECUTING`, `BLOCKED`, `RECOVERY_REQUIRED`, and `DONE` is reconstructed from durable facts and current authority. It is not stored as a privileged lifecycle document.

For the full model, read [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## What is proved?

The executable and formal proofs currently establish bounded claims about the core loop:

- **Projection is reconstructible.** Current project state can be rebuilt from immutable obligation, claim, and receipt facts after materialized status/cache state is deleted. The authority history contains no privileged `state.json`.
- **Projection is separable from storage transport.** Pure fact replay and lifecycle derivation are tested independently from storage mechanics, and the durable-fact contract is exercised against both SQLite and Git.
- **Claims are exact-revision bound.** Stale authority and stale semantic obligation identity are rejected rather than silently reinterpreted.
- **Execution authority is independently fenced.** Within the kernel permit boundary, recovery can rotate an in-flight run to a new execution generation without changing its claimed revision; the old generation's ephemeral permit is then rejected.
- **The normal core loop cannot invoke its effect handler before reservation.** Preflight judgment happens before the effect boundary; then the kernel validates the execution permit and durably reserves the effect before invoking the effect callback. The callback receives the work packet, not the `ExecutionPermit`; a failed reservation means provider code is never called.
- **Unresolved effects survive authority handoff.** Effects routed through the kernel reservation boundary are durably reserved before mutation; a successor generation may reconcile the reservation but cannot issue another effect through that boundary until authoritative observation settles it.
- **Semantic dependency identity is explicit.** Control dependencies constrain executability; semantic dependencies contribute selected upstream identity to downstream meaning. Historical realizations are reused only when the current obligation key still matches.
- **Workers are disposable.** A worker can disappear with its checkout, cache, local database, refs, and process memory; a fresh worker can reconstruct the unresolved run from authority and reconcile it.
- **Settlement is independent of worker assertion.** Verification semantics are committed before execution and authoritative readback determines whether the required postcondition actually holds.
- **Uncertain mutation does not authorize blind replay.** New receipt v5 replay requires a validated, provenance-bearing absence certificate whose kind is explicitly accepted by the verifier. Hostile eventually consistent and GitHub collection-negative readback mint no such certificate and remain recovery-bound.
- **Independent effects can overlap.** Concurrent obligations can remain executing while project-authority updates still serialize through CAS.
- **Mechanically knowable conflicts fail at admission.** For the GitHub commit-status adapter, incompatible unordered effects on the same canonical coordinate are rejected before a definition or amendment can enter authority, while explicitly identical effects may commute.
- **The hosted trust-boundary proof separates worker authority from provider mutation authority.** The disposable worker has `contents: read` but no `statuses: write`; its direct status-write attempt is rejected by GitHub, it emits a candidate effect intent, and a separate trusted broker validates, reserves, and performs the provider mutation before fresh-generation recovery settles from authoritative readback.
- **The formal kernel checks the intended safety boundary.** The TLA+ model covers stale execution authority, stale revision evidence, unsafe replay, unresolved mutation reservations, and false `DONE`; paired negative controls demonstrate counterexamples when each guard is removed.

The detailed empirical lineage and live hosted proof evidence live under [`experiments/`](./experiments/README.md). The claim taxonomy lives in [`research/claims.md`](./research/claims.md), with a layer-by-layer witness map in [`research/proof-obligations.md`](./research/proof-obligations.md).

## What is not proved?

The repository deliberately does **not** establish that:

- Overcenter is a complete production orchestration system;
- SQLite is a final distributed/HA authority substrate or suitable for every future deployment scale;
- arbitrary existing histories can be moved byte-for-byte between Git and SQLite without remapping backend-local authority identities;
- every project eventually makes progress or completes;
- external providers are correct, available, strongly consistent, or recoverable;
- one generic adapter can safely describe arbitrary external mutations;
- arbitrary workflow semantics are sound beyond the graph and amendment rules modeled here;
- every execution substrate physically separates worker credentials from provider-mutation credentials;
- direct low-level callers outside `runCoreLoop` cannot bypass the execution-permit/effect-reservation API;
- the trusted GitHub effect broker has coordinate-scoped least privilege for status writes. GitHub's `statuses: write` permission is repository-scoped;
- every provider or execution substrate offers an equally strong physical credential boundary; the demonstrated hosted boundary is specifically GitHub Actions job permissions.

The safety claim is narrower: an uncertain or even locally hostile worker does not get to manufacture authoritative project truth merely by claiming success.

## Repository map

```text
src/          reusable reference mechanism and trusted executor client
contracts/    versioned machine-readable data contracts
executor/     Go physical computation executor
test/         focused invariants of that mechanism
experiments/  executable empirical and adversarial proofs
formal/       machine-checked safety model and negative controls
research/     prior art, synthesis, claims, and design arguments
examples/     small runnable demonstrations
.github/      hosted proof workflows
```

Important entry points:

- [`src/kernel.ts`](./src/kernel.ts) - production SQLite-backed kernel entry point.
- [`src/kernel-core.ts`](./src/kernel-core.ts) - storage-neutral transaction, recovery, and settlement policy.
- [`src/fact-store.ts`](./src/fact-store.ts) - minimal durable-fact authority contract.
- [`src/sqlite-store.ts`](./src/sqlite-store.ts) - production append-only SQLite authority store.
- [`src/git-kernel.ts`](./src/git-kernel.ts) and [`src/git-store.ts`](./src/git-store.ts) - Git reference implementation of the same durable-fact contract.
- [`src/facts.ts`](./src/facts.ts) - durable fact schemas plus obligation/fact validation.
- [`src/digest.ts`](./src/digest.ts) - canonical structured hashing and raw SHA-256.
- [`src/evidence.ts`](./src/evidence.ts) - provider-general absence-certificate envelope plus current local-file certificate validation.
- [`src/semantics.ts`](./src/semantics.ts) - provider-specific realization identity and effect-coordinate semantics.
- [`src/graph.ts`](./src/graph.ts) - provider-agnostic dependency topology, validation, and ordering queries.
- [`src/admission.ts`](./src/admission.ts) - deterministic settlement-policy, semantic-edge, and static effect-safety checks before new definitions or amendments enter authority.
- [`src/projection.ts`](./src/projection.ts) - pure replay reducer from durable fact commits to historical project facts.
- [`src/projector.ts`](./src/projector.ts) - the single derived project-status/claimability projection.
- [`src/realization-admissibility.ts`](./src/realization-admissibility.ts) - fresh-authority classification for historical realization reuse.
- [`src/model.ts`](./src/model.ts) - public obligation, work, run, and postcondition contracts.
- [`src/observation.ts`](./src/observation.ts) - authoritative observation and verification boundary.
- [`src/computation-execution.ts`](./src/computation-execution.ts) - exact-byte computation execution/evidence contract on the trusted TypeScript side.
- [`src/computation-runner.ts`](./src/computation-runner.ts) - first production pure-computation cutover: TypeScript claims READY test work, delegates physical execution to Go, then settles only from independent observation.
- [`src/go-executor-client.ts`](./src/go-executor-client.ts) - Unix-socket client for an isolated physical executor.
- [`contracts/computation-execution-v1/`](./contracts/computation-execution-v1/) - shared versioned wire contract and conformance corpus.
- [`executor/`](./executor/README.md) - Go physical computation executor, containment boundary, and recovery rules.
- [`experiments/README.md`](./experiments/README.md) - proof inventory and experiment history.
- [`formal/`](./formal/) - TLA+ transaction/recovery kernel.
- [`research/README.md`](./research/README.md) - research map.

## Evidence ladder

The command name states what kind of evidence a green check supports:

| Command | Evidence |
| --- | --- |
| `npm test` | Fast deterministic regression: focused unit/integration invariants only. |
| `npm run proof:local` | Adversarial local experiments, including Git/CAS stress. |
| `npm run proof:formal` | Model checking of the formal transaction/recovery model. |
| `npm run proof:production` | Supported SQLite + Go computation slice, containment, recovery, and deterministic regression. |
| `npm run proof:live` | All hosted real-provider proofs, waited to completion at one exact source revision. |

These are different evidence classes, not cumulative certification levels. A live provider proof does not replace deterministic regression or model checking, and a checked model does not prove that the implementation or provider boundary is correct.

`.github/workflows/tests.yml` enforces the first three tiers on every pull request and every push to `main`. The live tier remains separate because it exercises real provider boundaries and permissions.

Requirements:

- Node.js at the exact version declared in [`.node-version`](./.node-version);
- Go at the version declared in [`executor/go.mod`](./executor/go.mod) for the physical computation executor;
- Docker for the catastrophic executor-death containment proof;
- Git;
- Java 21 for the TLA+ model;
- network access on the first formal run unless `TLA2TOOLS_JAR` already points to the pinned TLC jar;
- GitHub CLI authentication for `proof:live`.

The focused underlying commands remain available when debugging a particular claim:

```sh
npm run test:projection
npm run test:dependency-edges
npm run test:handoff
npm run test:eventual
npm run test:concurrency
npm run test:effect-order
npm run test:github-observation
npm run test:stress
npm run test:storage
npm run test:computation-executor
npm run demo                       # production SQLite kernel
npm run demo:git                  # Git reference backend
```

`proof:live` dispatches and waits for all three hosted proofs: the disposable-agent trust boundary, the generated GitHub observation/readback proof, and the exact GitHub-object transport proof. It resolves the requested ref once, requires every workflow run to report that exact source SHA, and fails if dispatch cannot be attributed to a concrete run or any run fails.

To target a non-default branch:

```sh
npm run proof:live -- --ref <branch>
```

The live command is intentionally fail-closed: successful workflow dispatch is not treated as successful proof.

## Go deeper

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the consolidated architecture, invariants, state model, graph semantics, and glossary.

Read [`research/README.md`](./research/README.md) for the prior-art map, including Bazel/Nix, CALM, distributed fencing, FoundationDB transaction semantics, Kubernetes/Flux reconciliation, Petri nets, TLA+, transition attestations, and durable execution systems.

The repository's standing architectural test is:

> Is this a judgment that requires reasoning, or mechanically knowable execution correctness?

Overcenter tries to keep the former with reasoning agents and move the latter into deterministic software.
