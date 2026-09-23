# Merkleized execution receipts

## Question

Can Overcenter make the proof underneath historical settlement content-addressed
without weakening the existing rule that provider truth comes from authoritative
observation rather than worker assertion?

This is a sidecar experiment. Production receipt-v5, SQLite authority, settlement,
and project projection remain unchanged.

```text
obligation + authority
        |
        v
     execution
      /    \
   trace   effect attempt
      \      /
       observation
           |
       verification
           |
       settlement root
```

Every object is canonically encoded and addressed by SHA-256 over its complete
contents, including named parent hashes. Historical disposition is derived only
after the complete reachable closure verifies and the semantic coordinates agree.

## Preregistered hypothesis

For the modeled production GitHub commit-status path, a content-addressed causal
receipt DAG will:

1. detect byte corruption;
2. detect a missing causal dependency;
3. reject copied verification from source SHA A onto source SHA B even when both
   source commits have the same tree digest;
4. reject an internally valid stale root when an independently signed latest-root
   checkpoint names a newer root;
5. reconstruct historical DONE after deleting the mutable lifecycle cache; and
6. preserve RECOVERY_REQUIRED when a timed-out external mutation has no
   authoritative readback, including rejecting a forged DONE node over that same
   evidence.

A false DONE in any hostile case falsifies the experiment.

## Why the checkpoint is part of the hypothesis

Merkle closure detects mutation inside a proof, but an old proof can still be
perfectly valid. Anti-rollback therefore requires an authority statement outside
the database being checked. The experiment uses a signed Ed25519 checkpoint for
that role. This is deliberately smaller than a transparency service or consensus
system.

## Production surface exercised

The fixture uses the current GitHub commit-status effect identity and models its
existing exact coordinates:

```text
repository_id
commit_sha
context
expected_state
source_sha
execution generation / authority revision
```

The experiment never treats a hash as evidence that GitHub told the truth.
Authoritative readback remains a semantic requirement for DONE.

## Measurements

The run emits:

- Merkle object count;
- canonical byte size of the receipt closure;
- byte size of an equivalent flat sidecar record;
- median sidecar construction latency; and
- median closure + semantic validation latency.

These measurements are observational in this first feasibility run. There is no
post-hoc performance threshold.

## Non-claims

This experiment does not prove full process/syscall/network deterministic replay,
current-world admissibility of mutable historical realizations, production
checkpoint key management, distributed transparency, or that the existing
receipt-v5 representation should be replaced.

## Running

```sh
npm run test:merkle-execution-receipts
```
