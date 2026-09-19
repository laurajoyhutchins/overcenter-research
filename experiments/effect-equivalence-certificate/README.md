> **Narrowed by PR #70.** This experiment proves that an equivalence assertion can be recomputed and provenance-bound. It does **not** by itself prove that the underlying provider effects are equivalent. PR #70 narrows the production claim to settlement equivalence and supplies the live GitHub provider witness plus a mixed-state counterexample.

# Provider effect-equivalence certificate

## Question

Can Overcenter replace `sameDesiredCommutes: boolean` with a recomputable, provenance-bearing witness that binds the exact claim under which same-coordinate effects may remain unordered?

## Shape

The experiment mints a certificate only from trusted production semantics:

```text
authoritative postcondition
          │
          ├── provider contract
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
- canonical coordinate contract;
- observation contract;
- provider operation class;
- canonical mutation resource;
- requested operation;
- equivalence class;
- digest of the production effect semantics under that contract;
- digest of the production settlement semantics under that contract;
- issuer-contract version;
- digest of the complete payload.

Validation does not trust the supplied object. It reissues the expected certificate from the postcondition and trusted semantics, then compares the canonical result.

## Authorization rule

Two overlapping effects may remain unordered only when both certificates validate and agree on:

```text
provider
+ exact verifier contract
+ coordinate contract
+ observation contract
+ operation class
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
- coordinate contract;
- observation contract;
- operation class;
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

The version-bound certificate deliberately refuses to inherit that equivalence. The two verifier versions carry different observation-contract identities, so the pair needs a separate, explicit cross-version equivalence witness.

This means the experiment is stricter than the current production admission rule in one intentional place.

That is the point: adapter/version and observation semantics are material to an authority-bearing equivalence claim unless equivalence across versions has itself been established.

## Boundary

This certificate is a deterministic evidence object, not a cryptographic credential.

Its authority comes from being recomputed by trusted Overcenter code from authoritative postconditions and provider semantics. Signing arbitrary certificate JSON would not improve the claim unless the signer performed the same validation.

The named provider contracts in this experiment are still manually versioned declarations. A production implementation should place those declarations with the provider adapter that owns the semantics, not in generic scheduling code.

## Run

```sh
node --experimental-strip-types --test \
  experiments/effect-equivalence-certificate/certificate.test.ts
```
