# Overcenter Core Loop

This repository contains a deliberately minimal executable reference implementation of Overcenter's core idea:

```text
inspect authoritative state
        ↓
derive READY work
        ↓
claim @ exact revision
        ↓
execute uncertain action
        ↓
observe authoritative reality
        ↓
verify postcondition
        ↓
settle durable receipt
        ↓
recompute READY work ↺
```

The worker does **not** decide that its work succeeded.

## Two storage experiments

```text
src/kernel.js       SQLite-backed reference
src/git-kernel.ts   Git-backed prototype
```

The Git prototype asks whether the core loop can reduce durable shared authority to:

```text
immutable Git objects
        +
refs/overcenter/state
        +
CAS(expected SHA → new SHA)
```

For a local authority repository, CAS is `git update-ref <ref> <new> <expected>`.

For disposable agent clones, the same rule is enforced against the central authority with an exact leased push:

```text
git push \
  --force-with-lease=refs/overcenter/state:<expected-sha> \
  origin <new-sha>:refs/overcenter/state
```

The commit SHA is the authoritative state revision. Settlement and recovery commits carry `receipt.json`; older receipts remain reachable through Git history.

## Kernel-owned verification

Agents no longer supply an observation object or verifier function to settle work.

The obligation contains immutable verification semantics. The current deliberately tiny adapter is:

```ts
{
  verifier: 'file-content-equals/v1',
  path: '/authoritative/external/path',
  content: 'expected content'
}
```

`resolve(runId)` reads that external truth itself, hashes the expected and actual content, and deterministically chooses:

```text
matches expected       → DONE
authoritatively absent → READY
anything else          → RECOVERY_REQUIRED
```

So this is no longer possible:

```ts
settle(run.id, {
  disposition: 'DONE',
  observed: fabricatedEvidence,
  verify: () => true,
});
```

There is no caller-provided `DONE` verifier path.

The file-content verifier is intentionally only a proof adapter, not a proposed universal evidence model. Additional verifier kinds should have to earn their way in as deterministic kernel-owned semantics.

## Disposable-agent handoff

The strongest experiment in this branch is:

```text
central Git authority
        │
        ▼
fresh Agent A clone
        │
        ▼
claim exact run
        │
        ▼
perform external effect
        │
        X
delete Agent A repo, cache, DB, process memory
        │
        ▼
durable supervisor fact: run A terminated
        │
        ▼
fresh Agent B clone
        │
        ▼
reconstruct unresolved run from Git
        │
        ▼
observe external truth
        │
        ▼
reconcile same run
        │
        ▼
verified DONE
```

Agent B receives nothing from Agent A's local database or filesystem.

The test even creates a fake `agent-cache.sqlite` inside A's sandbox and then deletes the entire sandbox before B exists. Project truth survives because the claim was already committed to central Git authority.

The supervisor contributes only a termination fact for the exact run ID. `recoverInterrupted(runId)` refuses to recover a different active run.

This is the current boundary:

```text
Git owns:
  durable state
  exact identity
  history
  CAS
  receipts
  reconstruction

execution platform owns:
  "sandbox/run X has terminated"
```

No shared SQL database is required by the experiment.

## Fail-closed authority

Missing authority is not empty state.

If `refs/overcenter/state` disappears, all observational surfaces fail with `NOT_INITIALIZED`, including:

- `inspect()`
- `deriveReadyWork()`
- `receipts()`
- `recoverInterrupted()`

A disposable agent cannot confuse "I cannot see project truth" with "there is no work."

## Lost acknowledgement

Settlement and reconciliation are idempotent by run identity.

If reconciliation commits `READY` or `DONE` but its response is lost, repeating `reconcile(runId)` returns the existing durable receipt instead of reporting `UNKNOWN_RUN`.

## Current deliberate constraint

The prototype permits only **one active external effect at a time**.

That keeps one linear authoritative ref sufficient. Parallel graph execution, leases, PostgreSQL, and distributed heartbeat machinery remain deliberately absent until an experiment demonstrates they are required.

## Run it

Validated in the assistant sandbox with Node.js 22.16.0 and Git 2.47.3. The TypeScript path uses Node's built-in type stripping; there is no TypeScript compiler, loader, or package dependency.

```sh
npm test
npm run test:git
npm run test:handoff
npm run test:stress
npm run demo:git
```

Equivalent direct execution:

```sh
node --experimental-strip-types examples/git-demo.ts
```

## Current proof set

The sandbox validation covers:

- exact-revision claim ancestry;
- kernel-owned postcondition observation;
- wrong-but-real effects cannot become `DONE` or `READY`;
- only authoritative absence permits replay;
- stale-revision fencing;
- exact-run interrupted recovery;
- idempotent `DONE` and `READY` reconciliation after lost acknowledgement;
- missing authority fails closed on every read surface;
- ref-lock failure cannot partially claim;
- aggressive Git GC;
- SHA-256 repositories;
- 16 independent disposable clones contending on one central authority, with exactly one claim;
- complete destruction of Agent A followed by successful reconstruction and settlement by fresh Agent B.

The combined focused, handoff, and stress suites passed **17/17** in the sandbox before being committed.

## Files

```text
src/kernel.js                 SQLite reference kernel
src/git-kernel.ts             Git authority kernel
examples/demo.js              SQLite demo
examples/git-demo.ts          Git-native demo
test/kernel.test.js           SQLite proofs
test/git-kernel.test.ts       Git kernel proofs
test/disposable-agent.test.ts disposable-agent handoff proof
stress/git-stress.ts          adversarial Git/clone stress tests
research/                     prior research
```

The experiment is intentionally small. New machinery should have to demonstrate that Git authority plus disposable local state cannot provide the required safety first.
