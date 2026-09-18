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

The worker does **not** decide that its work succeeded. `DONE` can only be settled when an observation proves the obligation's postcondition.

## Two storage experiments

The repository now has two implementations of the same loop:

```text
src/kernel.js       SQLite-backed reference
src/git-kernel.ts   Git-object-database prototype
```

The Git prototype asks a narrower question:

> Can Git itself provide the durable database, exact revision identity, transaction fence, and receipt history needed by the core loop?

Its answer so far is yes.

The Git implementation stores state snapshots as ordinary Git objects and advances exactly one authoritative ref:

```text
refs/overcenter/state
          │
          ▼
       commit N
          │
          └── state.json
```

Settlement commits also contain `receipt.json`. Older receipts remain reachable through commit history.

The commit SHA is the state revision. Claims and settlements use Git's compare-and-swap ref update:

```text
git update-ref refs/overcenter/state <new> <expected-old>
```

If the ref no longer equals the exact revision the caller observed, the mutation loses rather than silently rebasing itself onto newer truth.

Bootstrap is explicit. `initialize()` creates the authority ref; ordinary definition and execution refuse to recreate it. If `refs/overcenter/state` disappears later, the kernel fails closed with `NOT_INITIALIZED` instead of silently constructing an empty database.

### Current deliberate constraint

The prototype permits only **one active external effect at a time**. That keeps one linear authoritative ref sufficient and makes the transaction argument easy to inspect.

This is intentional. Parallel execution should not be added until it proves that it needs either multiple authority refs or a more sophisticated merge/settlement protocol.

## Run it

The Git prototype is executable TypeScript. It is validated here with Node.js 22.16.0 using Node's built-in `--experimental-strip-types` support and Git 2.47.3. There is no TypeScript compiler, loader, or package dependency in the execution path.

```sh
npm test
npm run demo

npm run test:git
npm run test:stress
npm run demo:git

# Equivalent direct execution:
node --experimental-strip-types examples/git-demo.ts
```

## What the Git prototype proves

The Git tests exercise real temporary bare repositories and prove:

- a commit SHA is the exact authoritative state revision;
- a claim commit is a child of the revision it claims;
- two readers of the same revision cannot both claim it;
- `DONE` still requires authoritative postcondition verification;
- settlement receipts are immutable commits in history;
- an uncertain external effect is not blindly replayed;
- restart converts an interrupted claim into a recovery commit;
- later observation can reconcile that exact run to `DONE`;
- a lost settlement acknowledgement is harmless because the authoritative ref already contains the settled state;
- 32 simultaneous claimers produce one authoritative claim;
- 16 complete loops racing one obligation execute the external effect exactly once;
- observer or verifier failure after execution durably enters recovery;
- ref-lock failure cannot partially claim work;
- loss of the authoritative ref fails closed;
- reachable state and receipts survive aggressive Git GC and SHA-256 object format;
- seeded crash/recovery state-machine runs preserve terminal receipt invariants.

The interesting shape is:

```text
refs/overcenter/state
        │
        ▼
      define
        │
        ▼
       claim
        │
   external effect
        │
        ▼
      settle
        │
        ▼
       claim
        │
        ▼
      settle
```

The commits are simultaneously snapshots, history, exact identities, and durable transaction evidence.

## Core invariant

> No obligation becomes `DONE` unless authoritative observation proves its postcondition for the claimed revision.

And for uncertain effects:

> If an external action may have happened, restarting the loop does not execute it again until reconciliation proves replay is safe.

The replay rule is deliberately stronger than "verification failed":

> Work may return to `READY` only when authoritative observation proves the attempted mutation is absent.

Anything else that is not verified `DONE` becomes `RECOVERY_REQUIRED` (or `WAITING` for an explicit judgment boundary).

### What Git does not provide

Git supplies durable snapshots, exact identities, history, and compare-and-swap ref updates. It does **not** provide a failure detector.

`recoverInterrupted()` therefore has an external precondition: something outside Git must know that execution was interrupted. Stress tests show that premature recovery of a still-live worker remains safe—no replay and no false `DONE`—but it forces reconciliation before progress can continue.

That is currently the clearest piece of machinery that survives the "Git is the database" simplification.

## Files

```text
src/kernel.js            SQLite executable kernel
src/git-kernel.ts        Git object database prototype
examples/demo.js         SQLite two-obligation demo
examples/git-demo.ts     Git-native history demo
test/kernel.test.js      SQLite safety/recovery proofs
test/git-kernel.test.ts  Git transaction/recovery proofs
stress/git-stress.ts      adversarial concurrency/crash/recovery suite
research/                prior research that motivated the kernel
```

This is intentionally small enough to read in one sitting. New machinery should have to justify why it cannot live behind this loop as deterministic software.
