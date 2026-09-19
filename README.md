# Overcenter

> Verified project transitions for uncertain software work.

[![Evidence](https://github.com/laurajoyhutchins/overcenter-research/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/laurajoyhutchins/overcenter-research/actions/workflows/tests.yml)

Overcenter is an executable research codebase for a narrow systems problem:

> How little trusted mechanism is required to turn uncertain agent activity into verified project truth?

The central rule is simple:

> **Reasoning agents make judgments. Deterministic software owns execution correctness.**

A worker may propose work, execute code, disappear, lie, crash, or return an ambiguous result. None of those events are project truth by themselves. Overcenter derives project state from durable authority, exact identity, authoritative observation, verification, and settlement.

```text
reasoning worker
  judgment, synthesis, candidate work
             |
             v
deterministic authority boundary
  identity, fencing, observation,
  verification, recovery, settlement
             |
             v
authoritative project truth
```

This repository is still a research codebase. It now also contains a deliberately narrow supported runtime slice. It is not yet a general-purpose production orchestrator.

## Current supported slice

| Concern | Current owner | Role |
| --- | --- | --- |
| durable authority and transaction history | TypeScript + SQLite | supported runtime path |
| graph semantics, claims, recovery, observation, settlement | TypeScript | authoritative |
| isolated replay-safe pure computation and attempt evidence | Go | admitted physical executor |
| Git fact store | TypeScript + Git | reference/replay backend |
| Rust, Lean, Datalog, F*, bounded exploration | experiments and proof oracles | non-authoritative |

The production computation boundary is intentionally narrow:

```text
SQLite authority
      |
READY + exact generation
      |
execution-context digest
      |
Unix socket attestation
      |
Go executor
      |
isolated task process
      |
attempt evidence
      |
TypeScript observation
      |
settlement
```

Go owns physical computation only. It does not derive graph eligibility, claim work, interpret provider state, mutate GitHub/Kubernetes/cloud resources, or settle project truth.

The supported executor profile is fail-closed and resource-bounded. The task runs without network access, with a read-only root and source snapshot, explicit UID/GID isolation, `no-new-privileges`, a minimal capability set, process and resource ceilings, and a fresh writable workspace.

Run the supported-slice proof with:

```sh
npm run proof:production
```

## Why Overcenter exists

Autonomous software work becomes dangerous when a probabilistic worker is also treated as the authority on whether its work succeeded.

Overcenter separates four things that are often collapsed together:

1. **Intent** - what should become true.
2. **Execution** - an attempt to make it true.
3. **Observation** - what authoritative reality says afterward.
4. **Settlement** - the durable decision that exact evidence satisfies the exact obligation.

That separation enables a few useful properties:

- a worker can disappear and recovery can continue from durable facts;
- stale execution authority is fenced rather than trusted;
- uncertain external mutation does not become permission to blindly retry;
- an old realization is reused only when it still satisfies the current semantic obligation;
- `READY`, `DONE`, and related states are projections over evidence rather than privileged mutable labels.

## Quick start

Use the exact Node.js version in [`.node-version`](./.node-version).

```sh
npm test
npm run demo
```

The default demo uses the SQLite authority backend.

The evidence commands are intentionally separated by claim type:

| Command | What a green result supports |
| --- | --- |
| `npm test` | fast deterministic regression |
| `npm run proof:local` | adversarial local experiments |
| `npm run proof:formal` | model-checked transaction/recovery safety |
| `npm run proof:production` | supported SQLite + Go computation slice |
| `npm run proof:live` | real hosted provider boundaries at one exact source revision |

These are different evidence classes, not certification levels. A live provider proof does not replace deterministic regression, and a checked model does not prove that an implementation or external provider is correct.

Additional requirements vary by proof tier:

- Go, at the version declared in [`executor/go.mod`](./executor/go.mod), for the computation executor;
- Docker for containment and catastrophic executor-death proofs;
- Java 21 for TLA+;
- GitHub CLI authentication for hosted live proofs.

## What the repository has established

The current evidence supports bounded claims including:

- **Reconstructible project state.** Current lifecycle projection can be rebuilt from durable facts and authority rather than a privileged mutable state document.
- **Exact authority fencing.** Claims, execution generations, evidence, and settlement are bound to exact identities and reject stale authority.
- **Recovery after worker loss.** A fresh worker can reconstruct unresolved work from authority without inheriting the previous worker's checkout, process memory, or cache.
- **No blind replay after uncertain mutation.** Retry requires provider-specific evidence strong enough to prove repetition is safe.
- **Independent settlement.** Worker success is attempt evidence, not project truth; deterministic verification and authoritative observation decide settlement.
- **Semantic realization reuse.** Existing realizations can satisfy current obligations when their material semantic identity still matches.
- **Provider-general observation structure.** GitHub and Kubernetes experiments share a structural observation/certificate model without pretending provider semantics are identical.
- **Bounded physical execution.** The admitted Go executor can perform isolated pure computation without owning graph or settlement authority.
- **Formal safety coverage.** The TLA+ kernel checks stale authority, exact-revision evidence, unsafe replay, unresolved mutation reservations, and false `DONE`, with negative controls that demonstrate counterexamples when guards are removed.

For the precise claim taxonomy and witnesses, see [`research/claims.md`](./research/claims.md) and [`research/proof-obligations.md`](./research/proof-obligations.md).

## What is not proved

This repository does **not** currently establish that:

- Overcenter is a complete general-purpose orchestration platform;
- SQLite is the final distributed or highly available authority substrate;
- every project eventually progresses or completes;
- every provider is correct, available, or strongly consistent;
- arbitrary workflow languages are sound beyond the modeled graph and amendment rules;
- every execution substrate provides the same physical credential boundary as the hosted proofs;
- every historical fact set can be migrated byte-for-byte between authority backends;
- a generic provider adapter can safely describe arbitrary mutation semantics.

The intended safety claim is narrower: uncertain or hostile worker activity should not manufacture authoritative project truth merely by asserting success.

## Repository map

```text
src/          authoritative TypeScript mechanism
contracts/    versioned cross-language contracts
executor/     Go physical computation executor
test/         focused mechanism invariants
experiments/  executable empirical and adversarial evidence
formal/       machine-checked safety model
research/     prior art, claims, synthesis, and design arguments
examples/     small runnable demonstrations
.github/      hosted evidence workflows
```

A useful implementation reading order is:

- [`src/kernel.ts`](./src/kernel.ts) - SQLite-backed kernel entry point
- [`src/kernel-core.ts`](./src/kernel-core.ts) - storage-neutral transaction, recovery, and settlement policy
- [`src/fact-store.ts`](./src/fact-store.ts) - durable-fact authority contract
- [`src/sqlite-store.ts`](./src/sqlite-store.ts) - production authority store
- [`src/projector.ts`](./src/projector.ts) - derived lifecycle/claimability projection
- [`src/observation.ts`](./src/observation.ts) - authoritative observation and verification boundary
- [`src/computation-runner.ts`](./src/computation-runner.ts) - TypeScript side of admitted pure-computation execution
- [`executor/`](./executor/README.md) - Go executor protocol, isolation, and recovery rules

## Read next

If you want the architecture rather than the tour, start with [`ARCHITECTURE.md`](./ARCHITECTURE.md).

For evidence and research:

- [`experiments/README.md`](./experiments/README.md) - experiment inventory and how to interpret results
- [`formal/README.md`](./formal/README.md) - transaction/recovery model and negative controls
- [`research/README.md`](./research/README.md) - prior-art map and synthesis
- [`research/claims.md`](./research/claims.md) - what kind of claim each proof actually supports
- [`research/proof-obligations.md`](./research/proof-obligations.md) - implementation-to-evidence witness map

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

The short version: changes should name the claim they affect, the hostile case that could falsify it, and the smallest evidence that distinguishes success from failure. New runtime machinery should earn its authority boundary rather than arriving because a language or abstraction is appealing.

For suspected security issues, see [`SECURITY.md`](./SECURITY.md).

## Architectural test

When adding machinery, ask:

> Is this a judgment that requires reasoning, or mechanically knowable execution correctness?

Keep the judgment with the reasoning system. Move repeatable correctness into software with explicit identity, authority, evidence, and failure semantics.
