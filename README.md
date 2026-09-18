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

## Run it

Requires Node.js 22.5 or newer. The implementation uses Node's built-in `node:sqlite`, so there are no package dependencies.

```sh
npm test
npm run demo
```

## What is implemented

`src/kernel.js` is the whole runtime kernel. It provides:

- durable obligations, runs, and receipts in SQLite;
- deterministic dependency/frontier derivation;
- exclusive claim with exact-revision fencing;
- an injected `execute → observe → verify` boundary;
- settlement that rejects unverified `DONE`;
- `RECOVERY_REQUIRED` for uncertain effects;
- restart recovery that prevents blind replay of interrupted work;
- reconciliation of uncertain work from later authoritative observation.

The implementation intentionally omits APIs, cloud hosting, GitHub-specific behavior, schedulers, notifications, generalized command frameworks, and agent bookkeeping.

## Core invariant

> No obligation becomes `DONE` unless authoritative observation proves its postcondition for the claimed revision.

The tests also demonstrate the complementary recovery rule:

> If an external action may have happened, restarting the loop does not execute it again until reconciliation proves replay is safe.

## Files

```text
src/kernel.js       executable kernel
examples/demo.js    two-obligation end-to-end loop
test/kernel.test.js safety and recovery proofs
research/           prior research that motivated the kernel
```

This is intentionally small enough to read in one sitting. New machinery should have to justify why it cannot live behind this loop as deterministic software.
