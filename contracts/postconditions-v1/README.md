# Postconditions contract v1

Postconditions are verifier-owned descriptions of the state that makes an obligation complete.

They are not application packets. Overcenter interprets them for admission, static effect ordering, observation, settlement, current-realization reuse, and semantic dependency identity. Their shape and semantics are therefore reusable core contracts.

## Admission boundary

Obligation facts use `overcenter-git-obligation-v4`. Every admitted postcondition must satisfy this canonical contract, including closed fields and verifier-specific bounds.

```text
define/amend
    |
    v
canonical postcondition
    |
    v
obligation v4 fact
```

Earlier obligation discriminators are not adapted into this contract. They fail closed at authority-fact admission.

## Semantic ownership

The JSON Schema owns mechanically knowable shape. `src/postconditions.ts` enforces the canonical write boundary.

`src/semantics.ts` owns reusable semantic derivations such as accepted absence-evidence kinds, verified-content identity, provider effect resource/desired state, and same-desired commutativity.

Observation and settlement consume those semantics but do not redefine the postcondition contract.
