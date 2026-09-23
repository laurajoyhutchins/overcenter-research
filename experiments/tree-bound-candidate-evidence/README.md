# Tree-bound candidate evidence

## Question

After deterministic regressions have been proven independent of ambient Git metadata, are the remaining expensive non-self-application candidate proofs also independent of commit identity?

## Hypothesis

Git stress, TLA+, and the production computation boundary are functions of source/toolchain content rather than the ambient repository revision.

The experiment is deliberately stronger than source inspection: it runs all three from a filesystem snapshot with no `.git` directory after removing common revision-coordinate environment variables.

## Reproduce

```sh
npm run test:tree-bound-candidate-evidence
```

Material prerequisites are the same as the production candidate runner: Java 21, Go from `.go-version`, Rust from `rust-toolchain.toml`, Docker, Node.js from `.node-version`, and network access if pinned formal/toolchain artifacts are not already cached.

## Success criteria

- copied source has no `.git`;
- ambient `git rev-parse --show-toplevel` fails;
- common revision-coordinate environment variables are absent from child proofs;
- `npm run test:stress` passes;
- `npm run proof:formal` passes;
- `npm run proof:production-boundary` passes.

## Interpretation

A positive result classifies these evidence bodies as tree/toolchain-bound under the tested environment. Combined with the Git-metadata-independence experiment for unit and deterministic experiment suites, it means the expensive candidate body can be factored into:

```text
tree/toolchain-bound:
  unit regression
  deterministic experiments
  Git stress
  TLA+
  production computation boundary

revision-bound:
  exact-head lineage/admission
  self-application execution context and attestation
```

This still does not authorize cross-revision evidence reuse. A separate derivation contract must bind reusable tree evidence to an exact merge revision and preserve toolchain/environment identity.

## Non-claims

- Self-application is tree-bound.
- Provider/live evidence is tree-bound.
- Equal Git trees imply equal execution identities.
- Toolchain or runner identity is irrelevant.
- The live Merge gate may skip post-merge evidence.
