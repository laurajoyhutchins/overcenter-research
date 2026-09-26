# Getting started

Overcenter Research is an executable research prototype, not a packaged production orchestrator. A useful first session should establish three things separately: the checkout is healthy, the deterministic kernel works locally, and the GitHub-hosted semantic command path is understandable.

## Toolchains

Use the repository-pinned versions:

- Node.js from [`.node-version`](../.node-version) (`22.16.0` at this revision);
- Go from [`.go-version`](../.go-version) when running the computation-executor proofs;
- Rust from [`rust-toolchain.toml`](../rust-toolchain.toml) when building the confinement launcher or portable worker client;
- Java 21 for the TLA+ proof runner.

The TypeScript production layer has no npm runtime dependencies. Development dependencies still need to be installed for typechecking.

## Verify a checkout

From the repository root:

    npm install
    npm run typecheck
    npm run test:unit
    npm run demo:sqlite

`npm run demo:sqlite` is the smallest local demonstration of the production SQLite authority path. It does not reproduce the hosted credential boundary or the complete production proof.

For the supported production slice, run:

    npm run proof:production

That proof may require the additional pinned toolchains and host capabilities documented by the execution subcomponents.

## The live operator loop

The supported operator surface is deliberately only `project.advance` and `project.submit`. See [`operator-commands.md`](./operator-commands.md).

On GitHub, these are semantic command anchors rather than ordinary form-style dispatches:

1. A push to `main` creates the `Overcenter command · project.advance` workflow run and builds the exact portable worker client.
2. The first `project.advance` job attempt advertises the command. Rerunning that same job asks Overcenter to execute the command at the exact source revision associated with the run.
3. Overcenter reconciles `.overcenter/project-intent.json`, derives project state, and either returns a state or publishes an immutable work packet when reasoning is required.
4. A worker receiving a packet runs the included native client as:

       ./overcenter run assignment.json workspace candidate.json

   The worker may produce candidate bytes, but it cannot settle project truth.
5. Candidate publication uses the repository's `overcenter/candidate/<run-id>` handoff. The internal handoff workflow carries no write authority; it merely anchors a `project.submit` command run.
6. Rerunning the advertised `project.submit` job validates that exact candidate against fresh authority and independently observed postconditions before settlement.

The workflow mechanics are intentionally less important than the semantic contract:

    project.advance -> exact assignment -> untrusted work -> project.submit -> verified settlement

A worker never chooses its own obligation, acquires its own settlement authority, or declares itself successful.

## Where to go next

- Declare work with [`project-intent.md`](./project-intent.md).
- Understand recovery before touching an interrupted effect: [`recovery.md`](./recovery.md).
- Add provider semantics only through the checklist in [`providers.md`](./providers.md).
- Read [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full model and [`../research/claims.md`](../research/claims.md) for the claim taxonomy.
