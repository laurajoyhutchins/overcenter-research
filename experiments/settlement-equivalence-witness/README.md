# Settlement-equivalence witness

## Claim

This witness does **not** claim two provider effects are physically identical or historically commutative.

It claims something narrower:

> Under the exact observation and settlement contracts named by this witness, these same-coordinate operations derive the same Overcenter project truth and therefore do not require a graph ordering edge.

For GitHub commit statuses, repeated writes may create multiple provider records with different metadata. The witness deliberately does not erase that fact.

## Construction

```text
provider postcondition
        │
        ├── coordinate contract
        ├── observation contract
        ├── mutation contract
        └── settlement semantics
                 │
                 ▼
      settlement-equivalence witness
```

The witness is deterministic and recomputable. Supplied JSON has no authority on its own.

## What local hostile tests establish

They establish integrity of the assertion:

- coordinate or desired-state drift invalidates the witness;
- provider/verifier/observation/mutation contract drift invalidates it;
- tampering invalidates it;
- unsupported effects cannot mint one;
- cross-verifier equivalence is not inherited from matching strings.

They do **not** establish that GitHub actually satisfies the equivalence assertion. That claim is tested separately by the hosted `github-settlement-equivalence/` experiment using real provider writes and production readback.

## Run

```sh
npm run test:settlement-equivalence-witness
```
