# Merkle evidence leaves

## Why this experiment exists

The authority-bound receipt DAG reached 0.506x the flat bytes at 128 receipts,
but inspecting the production store exposed an overlap: Overcenter already has an
outer content-addressed authority spine.

SQLite commit IDs are canonical digests over sequence, parent, message, and fact
files. History reads recompute those digests and verify the parent chain. Git
provides the same broad property natively.

So this experiment asks whether a second receipt DAG is unnecessary.

## Treatment

Keep the existing authority fact commit:

```text
authoritative fact commit
  receipt identity
  claimed revision
  execution authority
  kind / settled_at
  observed_ref: sha256:...
             |
             v
       evidence CAS
       certified observation
```

Only the repeated certified observation becomes a content-addressed leaf. The
receipt remains structurally flat, and the existing fact-commit digest continues
to bind run and authority identity.

## Corpus

128 successful GitHub commit-status executions are generated through the
production kernel and effect adapter. Unlike the preceding experiment, the
receipt fact used by the treatment is then read back through
`SqliteFactStore.history`, so the existing authority-store integrity checks run
before the leaf transform.

## Preregistered criteria

The leaf treatment must:

- round-trip all 128 receipt-v5 facts exactly;
- preserve production `projectReceipt` disposition and verification;
- use <=0.56x the flat canonical bytes at 128 receipts;
- store exactly one evidence leaf for this repeated-evidence corpus;
- detect evidence mutation under an existing digest;
- refuse missing evidence;
- leave per-run identity protected by the existing outer commit digest.

The 0.56x threshold was chosen before this run from the already-known full-DAG
result of 0.506x. It allows roughly 10% storage slack in exchange for deleting
the second per-execution DAG and its separate root-authority concern.

## Running

```sh
npm run test:merkle-evidence-leaves
```

## Hosted result

Evaluated at exact revision:

```text
1ad6c4f97d698f3e194b5e8ec74bf4050084bf14
```

GitHub Actions run `35822020117`, job `107055707500`, passed.

```text
receipt-v5 facts                         128
semantic mismatches                        0
false DONE                                 0
content-addressed evidence objects         1

evidence-leaf / flat bytes
  1 receipt                            1.053x
  8 receipts                           0.402x
 32 receipts                           0.322x
 64 receipts                           0.308x
128 receipts                           0.302x

same-host full receipt DAG @ 128        0.506x
```

The smaller treatment therefore beat the preregistered 0.56x threshold and the
full receipt DAG on the same hosted run.

The architectural result is not "Merkleize everything." It is:

```text
existing authority spine
  SQLite canonical fact-commit chain
  or Git commit graph
            |
            | settlement fact keeps exact identity
            | and references evidence digest
            v
content-addressed evidence leaves
  certified observations
  execution traces
  large replay inputs
```

This keeps authority singular. The fact commit says which evidence counts; the
evidence digest says exactly which bytes were observed. Missing or corrupted
evidence fails closed, while repeated evidence can be stored once.

For this corpus, a second per-execution receipt DAG is additional machinery with
worse canonical storage than the leaf-only design.
