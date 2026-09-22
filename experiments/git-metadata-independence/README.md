# Git-metadata independence

## Question

Can the deterministic candidate regression and experiment suites execute from repository source bytes with no ambient Git worktree or commit identity?

## Claim

After removing the two accidental ambient-checkout dependencies in `config-contract.test.ts` and `github-agent-ingress.test.ts`, both `test:unit` and `test:experiments` can execute from a filesystem source snapshot that contains no `.git` directory and for which `git rev-parse --show-toplevel` fails.

Tests remain free to create their own temporary Git repositories when Git behavior is the subject under test.

## Contrast

Treat the whole regression suite as revision-bound merely because a few fixtures use the caller's checkout as a convenient file inventory or copy mechanism.

## Reproduce

```sh
npm run test:git-metadata-independence
```

The experiment copies the repository source tree through deterministic filesystem plumbing, proves that the copy has no ambient Git identity, and runs both candidate regression suites inside that copy.

## Success criteria

- the copied source contains no `.git`;
- ambient `git rev-parse --show-toplevel` fails in the copied source;
- `npm run test:unit` passes there;
- `npm run test:experiments` passes there;
- tests that intentionally exercise Git continue to use explicit temporary repositories.

## Interpretation

A positive result establishes that these deterministic suites are functions of the checked-out source/tool environment rather than the ambient repository commit identity. It is a prerequisite for tree-bound evidence reuse, not authorization to perform that reuse.

The formal proof, production boundary, self-application, hosted provider proofs, and revision/lineage derivation remain separate evidence classes.

## Non-claims

- Every candidate evidence class is tree-bound.
- Source-tree equality is sufficient for merge evidence substitution.
- Current self-application evidence may be reused across commit SHAs.
- Git is absent from the tests; tests may create isolated Git fixtures.
- This experiment changes merge admission or the live Merge gate.
