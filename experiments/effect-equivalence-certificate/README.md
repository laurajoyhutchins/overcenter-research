# Provider effect-equivalence certificate

## Question

Can Overcenter replace `sameDesiredCommutes: boolean` with a recomputable, provenance-bearing witness that binds the exact claim under which same-coordinate effects may remain unordered?

## Shape

The experiment mints a certificate only from trusted production semantics:

```text
postcondition
     │
     ├── effectSemantics
     └── settlementSemantics
              │
              ▼
 effect-equivalence payload
              │
              ▼
       canonical digest
              │
              ▼
 equivalence certificate
```

The certificate binds:

- provider;
- verifier/adapter contract;
- canonical mutation resource;
- requested operation;
- equivalence class;
- digest of the production effect semantics;
- digest of the production settlement semantics;
- issuer-contract version;
- digest of the complete payload.

Validation does not trust the supplied object. It reissues the expected certificate from the postcondition and trusted semantics, then compares the canonical result.

## Authorization rule

Two overlapping effects may remain unordered only when both certificates validate and agree on:

```text
provider
+ exact verifier contract
+ canonical resource
+ semantic operation
+ equivalence class
+ effect-semantics digest
+ settlement-semantics digest
```

Different physical resources do not need this certificate because their concurrency comes from disjointness.

## Hostile controls

The tests require the old certificate to fail after changing:

- stable repository identity;
- exact commit;
- normalized status context;
- desired operation.

They also mutate the supplied certificate itself:

- resource;
- operation;
- verifier contract;
- issuer contract;
- certificate digest.

Unsupported provider semantics cannot mint a certificate.

## Cross-version falsification

The most useful hostile case is verifier-version skew.

Today `validateAdmission` accepts an unordered pair consisting of:

```text
github-commit-status/v1 success
github-commit-status/v2 success
```

when both resolve to the same canonical resource. That follows from the current boolean `sameDesiredCommutes` policy.

The version-bound certificate deliberately refuses to inherit that equivalence. The pair needs a separate, explicit cross-version equivalence witness.

This means the experiment is stricter than the current production admission rule in one intentional place.

That is the point: adapter/version identity is material to an authority-bearing equivalence claim unless equivalence across versions has itself been established.

## Boundary

This certificate is a deterministic evidence object, not a cryptographic credential.

Its authority comes from being recomputed by trusted Overcenter code from authoritative postconditions and provider semantics. Signing arbitrary certificate JSON would not improve the claim unless the signer performed the same validation.

## Run

```sh
node --experimental-strip-types --test \
  experiments/effect-equivalence-certificate/certificate.test.ts
```
