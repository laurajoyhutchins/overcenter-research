# Lean semantic oracle

**Status:** historical exact-revision evidence

The live TypeScript-vs-Lean differential was retired from current `main` after a successful exact-revision witness. Its result and reproduction coordinates remain durable; the executable test and workflow are recoverable from Git rather than carried indefinitely as active source.

## Evaluated coordinates

- Production revision: `766f581c1592f7f3193b95b3d18f47f7c5b22234`
- Pinned Lean reference: `39bd16a317bc2155a17b6674a5050adaf4295c90`
- GitHub Actions run: `35801357388`
- Job: `106992185603` (`TypeScript vs Lean semantic oracle`) — PASS

## What it established

At the evaluated revision, the production TypeScript implementation agreed with the independent Lean reference across the bounded mutation-authority, reservation-replay, receipt-replay, execution-authority, graph-validity, and normalized effect-ordering corpora. The graph corpus covered 8,192 directed four-node graph/dependency-kind comparisons plus hostile and mixed cases; the effect-order corpus covered 245,768 comparisons.

The witness did **not** make Lean a production runtime authority, prove provider-specific normalization, or establish universal equivalence beyond the proved Lean properties and bounded differential.

## Reproduce

Check out the evaluated revision first:

```sh
git checkout 766f581c1592f7f3193b95b3d18f47f7c5b22234
npm run test:lean-oracle
```

The historical `.github/workflows/lean-semantic-oracle.yml` at that revision records the pinned Lean build and environment used by the hosted witness. Current `main` intentionally does not carry that executable oracle lane.
