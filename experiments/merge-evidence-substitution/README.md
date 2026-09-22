# Merge evidence substitution

## Question

Can Overcenter avoid rerunning full candidate evidence on the GitHub merge commit when the merge commit has exactly the certified base and certified head as parents and its tree is byte-identical to the certified head?

## Hypothesis

A strict Git relation can prove that a merge commit is **content-preserving** relative to a certified pull-request head:

```text
merge.parents == [certified_base, certified_head]
merge.tree    == certified_head.tree
candidate.source_sha == certified_head
candidate.outcome    == success
```

The stronger hypothesis is that this relation is sufficient to substitute the candidate's exact-head evidence for evidence bound to the merge commit.

## Falsification criterion

The substitution hypothesis is false if any current verification identity changes solely because the Git commit identity changes while source-tree bytes remain identical.

That is exactly what the current self-application contract does: its execution context includes `source_sha`, and its trusted attestation bytes include the source SHA. Therefore identical trees at different revisions intentionally produce different execution identities.

## Experiment

```sh
npm run test:merge-evidence-substitution
```

The deterministic test proves four things:

1. the exact two-parent plus identical-tree relation is sufficient to identify a content-preserving GitHub-style merge;
2. reversed parents, octopus merges, changed trees, stale base/head evidence, and failed candidate evidence are rejected;
3. identical source-tree bytes at two revisions still produce different current Overcenter execution-context digests;
4. current trusted self-application attestation bytes also differ by source revision.

## Observed repository witness

PR #234 supplied a real content-preserving GitHub merge:

```text
certified base:  c70800559230b3d9286fb9d9107b87c14fab4f14
certified head:  392cad7c36cdb3c167c4e6a78d20056c23c0ab4c
merge commit:    a994978638a8d52cacac858b2f0ebeca75c2b681
head tree:       dc7fdb04d23ad7f3bde3b0a5edbdcf4ea8605f7c
merge tree:      dc7fdb04d23ad7f3bde3b0a5edbdcf4ea8605f7c
merge parents:   [c70800559230b3d9286fb9d9107b87c14fab4f14,
                  392cad7c36cdb3c167c4e6a78d20056c23c0ab4c]
candidate run:   35691651230
post-merge run:  35691877235
```

The Git relation satisfies the experiment's content-preserving predicate exactly. The repository still reran full Merge-gate evidence on the merge commit because the current proof identity is revision-bound.

An exact local Node 22.16.0 scratch execution of the checked-in TypeScript experiment against the current execution-context and digest implementations passed 4/4 tests on 2026-09-22: the positive witness, hostile near-misses, revision-identity falsifier, and attestation-identity falsifier.
## Result interpretation

A passing experiment **falsifies direct exact-evidence substitution under the current identity model**.

It does not say the post-merge rerun is forever unavoidable. It isolates the missing abstraction: a future proof would need to distinguish revision-independent **content evidence** from revision-bound **execution/lineage evidence**, then define an explicit derivation from the certified head to the merge commit without pretending the two executions have the same identity.

Until that exists, skipping the post-merge full proof solely because the Git trees match would weaken the exact-revision fence.

## Non-claims

- Tree equality alone proves execution equivalence.
- Git commit metadata is irrelevant to Overcenter evidence.
- A successful pull-request certification can currently be relabeled as merge-commit evidence.
- Squash merges, rebase merges, octopus merges, or merge commits with generated content satisfy this witness.
- The experiment authorizes changing the live Merge gate.
