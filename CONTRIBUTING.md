# Contributing to Overcenter

Overcenter is a research codebase with a deliberately small supported runtime surface. Contributions are most useful when they make a claim clearer, falsify an assumption, reduce trusted mechanism, or turn already-proven behavior into simpler deterministic software.

## Start with the claim

Before changing code, write down:

- **What exact claim is this code making?**
- **What hostile case would disprove it?**
- **What is the smallest experiment that distinguishes success from failure?**

For runtime changes, add one more question:

- **What authority does this component gain, and why is that authority necessary?**

A new implementation is not justified merely because it is elegant, faster in a microbenchmark, or pleasant to write.

## Evidence before promotion

Experiments belong in `experiments/`. Reusable runtime mechanism belongs in `src/`.

When an experiment suggests promoting a language, subsystem, storage backend, or abstraction into the supported path, prefer a differential result against a plausible existing alternative. The promotion should be narrower than the experiment whenever possible.

The current authority boundary is intentional:

```text
TypeScript + SQLite
  authority, graph, recovery,
  observation, settlement
          |
          v
Go
  admitted physical pure computation only
```

Do not move graph eligibility, provider interpretation, external mutation, settlement, or project truth into the Go executor without separate evidence that justifies changing that boundary.

## Prefer deterministic software over prompt bookkeeping

When a behavior is mechanically knowable, prefer putting it behind a semantic software boundary rather than asking an agent to remember it.

Typical examples include:

- exact identity and hashing;
- fencing and compare-and-swap;
- schema and authority validation;
- conflict detection;
- reconciliation and recovery-state derivation;
- evidence binding;
- projection from durable facts;
- counting and other routine bookkeeping.

Reasoning systems should spend their budget on judgment, synthesis, and ambiguous choices.

## Repository structure

```text
src/          supported reusable mechanism
contracts/    versioned cross-language contracts
executor/     admitted Go computation executor
test/         focused mechanism invariants
experiments/  bounded executable evidence
formal/       machine-checked models
research/     prior art, claims, synthesis
examples/     runnable examples
```

Keep historical evidence near the experiment that produced it. Keep the root README focused on the current public story.

## Running evidence

Use the exact Node.js version in `.node-version`.

Start with:

```sh
npm test
```

Then run the evidence class affected by your change:

```sh
npm run proof:local
npm run proof:formal
npm run proof:production
npm run proof:live
```

A change does not need every tier merely because the tiers exist. It does need evidence that actually covers the claim being changed.

For example:

- a pure projection refactor should have deterministic and differential coverage;
- a recovery-rule change should exercise adversarial local and formal evidence where applicable;
- an executor containment change should run the production computation proof;
- a real-provider semantic claim needs hosted evidence at an exact revision.

## Pull requests

A useful pull request description includes:

1. the claim or problem being changed;
2. the authority boundary before and after;
3. the hostile cases considered;
4. the evidence run at the exact proposed head;
5. deliberate non-goals.

Prefer small PRs whose correctness argument fits in one screen. Large architectural moves should normally be decomposed into an experiment, a result, and then the smallest justified production change.

## Documentation

Public documentation should distinguish:

- what is implemented;
- what is experimentally demonstrated;
- what is formally modeled;
- what remains a hypothesis.

Avoid turning old workflow runs, temporary branch names, or development chronology into the main explanation of the system. Preserve those details where they are useful as evidence, but make the current architecture the entry point.

## Design standard

The standing architectural test is:

> Is this a judgment that requires reasoning, or mechanically knowable execution correctness?

A strong contribution either improves the judgment surface or removes deterministic correctness work from it.
