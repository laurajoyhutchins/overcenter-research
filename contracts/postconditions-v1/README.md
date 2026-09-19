# Postconditions contract v1

Postconditions are verifier-owned descriptions of the state that makes an obligation complete.

They are not application packets. Overcenter interprets them for admission, static effect ordering, observation, settlement, current-realization reuse, and semantic dependency identity. Their shape and semantics are therefore reusable core contracts.

## Compatibility boundary

Historical obligation v3 facts were written when the nested postcondition boundary was permissive. Replay continues to accept those facts.

New obligation writes use `overcenter-git-obligation-v4`. V4 requires a canonical postcondition from this contract and rejects unknown nested fields.

```text
obligation v3 history
      |
      +--> legacy-compatible read
      |
new define/amend
      |
      v
canonical postcondition
      |
      v
obligation v4 fact
```

This asymmetry is deliberate. Tightening old v3 reads would make previously durable history invalid under a newer validator.

## Semantic ownership

The JSON Schema owns mechanically knowable shape. `src/postconditions.ts` enforces the canonical write boundary.

`src/semantics.ts` owns reusable semantic derivations such as accepted absence-evidence kinds, verified-content identity, provider effect resource/desired state, and same-desired commutativity.

Observation and settlement consume those semantics but do not redefine the postcondition contract.
