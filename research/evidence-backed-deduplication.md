# Evidence-backed deduplication

Overcenter's experiments are allowed to duplicate code on purpose. Production code is not.

That distinction matters because an independent implementation can be evidence, while two production paths that implement the same semantic decision are usually just two places for the same invariant to drift.

The cleanup rule is therefore:

> Once an experiment establishes a semantic owner, production should have one implementation of that semantic rule. Keep a second implementation only when its independence is itself useful evidence, when it is a reference/interchange backend, or when it owns a physically different execution boundary.

This is not a general "DRY at all costs" rule. Shared helpers can make an experiment less independent and therefore less useful.

## Experimental basis

### Storage authority: one semantic kernel, multiple storage adapters

The [storage backend bake-off](../experiments/storage-backend-bakeoff/README.md) compared the same append-only durable fact history through Git and SQLite. The [2026-09-19 results](../experiments/storage-backend-bakeoff/results/2026-09-19.md) established three relevant facts:

1. Git's current one-fact-per-object/ref write path remained near 15-18 fact commits/s in the measured environment, while SQLite was nowhere near the same hot-path bottleneck.
2. Both backends preserved exact compare-and-swap authority, identical canonical replay digests, and crash-safe committed prefixes for the tested workload.
3. The database did not need mutable lifecycle truth to get the performance win.

The follow-on storage work then made both implementations satisfy the same `DurableFactStore` contract and added [backend differential tests](../test/kernel-backend-differential.test.ts).

The architectural consequence is stronger than "SQLite is faster":

```text
project semantics
      |
      v
   KernelCore
      |
 DurableFactStore
   /         \
SQLite       Git
production   reference
```

The execution loop is project semantics. It is not Git semantics and SQLite does not need its own copy either.

That is why this cleanup removes the backend-specific `runGitCoreLoop` alias and makes both backends exercise the single `runCoreLoop` implementation.

Git remains intentionally present as a reference/replay backend. Deleting `GitFactStore` would throw away independent evidence; deleting a second name for the same semantic loop removes only redundant production surface.

### Projection: preserve the oracle, remove competing production truth

The [projection implementation bake-off](../experiments/projection-bakeoff/README.md) compared four approaches:

- authoritative mutable SQLite lifecycle;
- the TypeScript projector;
- status-free SQL derivation;
- Soufflé Datalog derivation.

The hostile corpus falsified authoritative mutable lifecycle as the preferred model. TypeScript, status-free SQL, and Datalog all reconstructed status without lifecycle repair writes.

The experiment's conclusion is deliberately asymmetric:

```text
architecture:                derived relational projection
production implementation:  TypeScript
independent executable oracle: Datalog
credible alternative:       status-free SQL
```

That is the deduplication pattern Overcenter should repeat. One production owner does not imply one implementation exists anywhere in the repository. The Datalog implementation stays valuable precisely because it is not the TypeScript implementation wearing a different hat.

## What should be deduplicated

Deduplicate when all of these are true:

1. Two paths claim the same semantic authority.
2. The repository has differential or adversarial evidence that they should produce the same result.
3. No physical authority boundary requires separate code.
4. The second path is not being kept as an independent oracle, reference format, compatibility boundary, or live experiment.
5. Removing it reduces the number of places where a correctness rule can drift.

Good candidates include:

- backend-specific aliases for storage-neutral kernel operations;
- repeated lifecycle/eligibility logic after a single projector has been established;
- provider-neutral validation copied into provider adapters;
- configuration parsing that gives two names to the same setting without a compatibility requirement.

## What should remain independent

Do not deduplicate merely because code looks similar when the similarity is part of the experiment.

Keep implementations separate when they provide:

- an independent executable oracle;
- a differential implementation used to falsify the production path;
- a provider-specific interpretation that cannot safely be flattened;
- a reference/interchange backend with independent reconstruction value;
- a physically distinct trusted boundary, such as the isolated Go computation executor.

The test is not "can these lines share a helper?" It is:

> Would sharing this implementation weaken the independence, authority separation, or hostile-case coverage that makes the evidence useful?

If yes, duplication is buying something real.

## First application

This cleanup starts with the storage-neutral execution loop.

Before:

```text
GitOvercenterKernel -> runGitCoreLoop -> runCoreLoop
OvercenterKernel    -------------> runCoreLoop
```

After:

```text
GitOvercenterKernel --\
                      +-> runCoreLoop
OvercenterKernel ----/
```

The backend differential test now changes only the backend while holding the semantic loop fixed. That makes the test say what the architecture says: storage is the variable; project-transition semantics are not.

## Ongoing rule

For each future deduplication, leave an evidence trail:

1. name the duplicated semantic claim;
2. identify the experiment or differential test that establishes the owner;
3. preserve any independent oracle/reference path that still earns its keep;
4. delete aliases, wrappers, state, or branches that no longer carry distinct authority;
5. run the smallest regression that would detect semantic drift, then the relevant evidence tier.

Code generation is cheap. Multiple sources of project truth are not.
