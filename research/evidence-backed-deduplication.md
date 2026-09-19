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

## Second application: semantic selector grammar

Semantic dependencies have two currently supported selectors:

```text
output   / verified-content
evidence / settlement-receipt
```

Before this cleanup, both admission and semantic identity independently encoded that selector grammar. They need different surrounding behavior:

- admission rejects unsupported selectors before authority changes and additionally checks that a selected output can actually be identified;
- replay/identity derives the exact selected identity from already admitted history.

What they do **not** need is two copies of the list of legal selector strings or two copies of the unsupported-selector error rule.

The [bounded graph exhaustion experiment](../experiments/bounded-graph-exhaustion/README.md) is the evidence for collapsing that grammar. Its typed dependency corpus exhaustively covers every graph through four vertices where each possible edge is absent, control, verified-content, or settlement-receipt. The current bound contains 4,165 typed graphs, plus 16,585 material-output mutations and 16,585 same-output resettlement cases. Production `validateAdmission` and `obligationKey` are both checked against independent reference rules over that corpus.

The focused [dependency-edge adversarial tests](../test/dependency-edge-adversarial.test.ts) additionally establish that unsupported selectors fail before a definition fact is committed.

So the shared boundary is now:

```text
                   semanticDependencySelection()
                         /             \
                        /               \
          admission-time checks     replay-time identity
          output availability       selected evidence
          authority unchanged       historical meaning
```

This is deliberately **not** a merger of admission and replay. It is one owner for the stable selector vocabulary while preserving the different safety jobs on either side.

## Third application: GitHub object identity grammar

The certified GitHub ref observer, pull-request observer, and top-level postcondition validator each independently recognized GitHub object IDs as 40-64 hexadecimal characters. The ref and pull-request paths also independently implemented case-insensitive identity comparison.

That is one provider contract repeated three times.

The [GitHub observation grammar experiment](../experiments/github-observation-grammar/github-observation.test.ts) is built around exact provider coordinates and exact revision identity across refs, pull requests, statuses, checks, and reconstruction. The production regressions in [`github-certified-ref.test.ts`](../test/github-certified-ref.test.ts) and [`github-certified-pr.test.ts`](../test/github-certified-pr.test.ts) separately exercise invalid revision inputs and stale/current identity behavior.

The deduplicated boundary is now:

```text
GitHub provider contract
  isGithubObjectId()
  sameGithubObjectId()
          |
          +--> postcondition validation
          +--> ref certification
          +--> pull-request certification
```

The observers still own their distinct coordinates, response slices, evidence, and stale/current rules. Only the provider-wide object-ID grammar and equality rule moved to one owner.

This is intentionally different from sharing validation across TypeScript and Go computation boundaries. GitHub object identity is one provider semantic contract inside the same trusted TypeScript authority layer. Cross-language executor validation is part of an isolation boundary and should remain independently checked unless an experiment shows that sharing it would not weaken that boundary.

## Fourth application: certified GitHub read plumbing

Repository, ref, pull-request, and commit-status observers all used the same mechanical sequence:

```text
materialized GET request
        |
        v
provider transport
        |
        v
RawObservation envelope
        |
        v
selected response-slice validation
        |
        v
structural certificate
```

The [provider observation reuse experiment](./provider-observation-reuse.md) already established the architectural boundary behind this sequence. GitHub and Kubernetes shared the observation envelope and structural certificate engine successfully, while provider-specific identity, completeness, freshness, and negative-evidence meaning remained local. In that experiment the corresponding second-provider observation/validator infrastructure fell from roughly 259 LOC in the standalone Kubernetes branch to roughly 101 LOC of shared/factored infrastructure plus provider-local semantics.

The production GitHub observers had already adopted the shared provider-general certificate engine, but they still repeated the GitHub-local transport-to-certificate plumbing around it. `observeCertifiedGithubRead200()` now owns that mechanical sequence once. Current `main` also added the broader positive-only `observeCertifiedGithubSemanticRead()` surface; that reader now composes the same low-level certificate path rather than becoming a second implementation of it.

It deliberately does **not** own:

- repository identity validation;
- ref canonicalization or stale/current meaning;
- pull-request identity fields;
- status collection completeness or pagination semantics;
- provider-negative evidence.

Those remain with their entity adapters.

This follows the experiment's falsification rule: share mechanics that turn a declared provider read into structurally certified evidence, but do not grow a generic provider lifecycle or flatten provider meaning.

## Ongoing rule

For each future deduplication, leave an evidence trail:

1. name the duplicated semantic claim;
2. identify the experiment or differential test that establishes the owner;
3. preserve any independent oracle/reference path that still earns its keep;
4. delete aliases, wrappers, state, or branches that no longer carry distinct authority;
5. run the smallest regression that would detect semantic drift, then the relevant evidence tier.

Code generation is cheap. Multiple sources of project truth are not.
