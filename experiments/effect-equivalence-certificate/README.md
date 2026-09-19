# Provider effect-equivalence certificate

## Question

Can same-coordinate concurrency be authorized by recomputable provider evidence instead of a generic commutativity boolean?

## Status

This experiment has graduated into the reusable semantics path.

The experiment module now re-exports the production implementation so its hostile tests exercise the same witness consumed by admission. There is no second certificate algorithm in `experiments/`.

## Witness construction

For GitHub commit statuses:

```text
authoritative postcondition
          │
          ├── coordinate semantics
          ├── observation contract
          ├── mutation contract
          └── settlement semantics
                   │
                   ▼
          provider witness payload
                   │
                   ▼
            canonical digest
```

The witness binds:

- provider;
- verifier contract;
- coordinate contract;
- observation contract;
- mutation operation class;
- provider-contract digest;
- canonical mutation resource;
- semantic operation;
- equivalence class;
- effect-semantics digest;
- settlement-semantics digest;
- issuer contract;
- complete certificate digest.

For GitHub, the provider-contract digest fences the API version, retained OpenAPI identity, HTTP method, and commit-status mutation route.

## Trust model

A supplied witness is never authoritative merely because it has the right JSON shape.

Validation re-derives the expected witness from the authoritative postcondition and trusted provider semantics.

The certificate is deterministic evidence, not a cryptographic credential. Signing arbitrary bytes would add nothing unless the signer performed the same derivation.

## Hostile controls

The proof rejects stale or forged:

- stable repository identity;
- exact commit;
- normalized context;
- desired operation;
- resource;
- verifier contract;
- coordinate contract;
- observation contract;
- mutation operation class;
- issuer contract;
- certificate digest.

Unsupported effect semantics cannot mint a witness.

## Cross-version boundary

GitHub status v1 and v2 may derive the same physical resource and desired state, but their observation/verifier contracts differ.

Production admission now fails closed:

```text
github-commit-status/v1 success
github-commit-status/v2 success
same resource
        ↓
different witness identity
        ↓
UNORDERED_EFFECT_CONFLICT
```

A future cross-version bridge must be explicit evidence. It cannot be inherited from matching strings.

## What remains unproved

The witness proves that trusted Overcenter provider code made an exact, version-fenced equivalence assertion.

It does not prove that the provider's complete physical history is identical under repeated operations. For GitHub statuses, repeated POSTs may still create multiple provider records. The equivalence claim remains scoped to the observation and settlement semantics named by the witness.

## Run

```sh
npm run test:effect-equivalence-certificate
```
