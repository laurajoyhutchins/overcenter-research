# Tree evidence derivation

## Question

Can Overcenter reuse tree/toolchain-bound candidate evidence for an identical-content merge **without** pretending that evidence executed on the merge revision?

## Hypothesis

Yes, if reuse is represented as a derivation rather than relabeling.

The derivation requires four separately validated objects:

1. a tree-evidence receipt containing no source revision coordinate;
2. provenance identifying the successful candidate run that produced that receipt;
3. an exact merge witness tying the merge to `[certified base, certified head]` and independently recomputing the same source-tree digest;
4. fresh revision evidence for the merge SHA.

The final merge-evidence bundle records the tree evidence as `derived`, not executed on the merge revision.

## Falsification criteria

The contract is inadequate if it admits any of the following:

- revision-bound fields inside the reusable tree-evidence receipt;
- failed candidate evidence;
- evidence from an unapproved proof contract or proof environment;
- stale/reversed parentage;
- a different Git tree;
- a different recomputed source-tree digest;
- revision evidence for the certified head instead of the merge;
- failed exact-lineage or self-application evidence.

## Reproduce

```sh
npm run test:tree-evidence-derivation
```

## Real witness

PR #234 supplies a real content-preserving GitHub merge relation:

```text
base:        c70800559230b3d9286fb9d9107b87c14fab4f14
head:        392cad7c36cdb3c167c4e6a78d20056c23c0ab4c
merge:       a994978638a8d52cacac858b2f0ebeca75c2b681
head tree:   dc7fdb04d23ad7f3bde3b0a5edbdcf4ea8605f7c
merge tree:  dc7fdb04d23ad7f3bde3b0a5edbdcf4ea8605f7c
```

That historical run predates the explicit tree-evidence receipt introduced by this experiment, so it is used only as a real merge-relation witness, not as retroactively reusable tree evidence.

## Interpretation

A positive result establishes a safe **shape** for evidence reuse:

```text
candidate H:
  execute tree evidence E(T, contract, environment)
  execute revision evidence R(H)

merge M:
  recompute T
  prove exact [base, H] merge relation
  derive applicability of E to M
  freshly execute R(M)
  admit M from derived E + fresh R(M)
```

The derivation proves applicability of prior evidence to the merge content. It never claims the prior evidence executed on M.

## Non-claims

- The current Merge gate already emits this receipt.
- Current workflow-run metadata alone is sufficient tree evidence.
- Provider/live evidence is reusable by tree identity.
- Revision-bound self-application evidence may be inherited.
- The live post-merge proof should change before the receipt and derivation mechanisms exist.
