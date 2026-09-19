# Lean semantic-dependency identity derivation experiment

## Question

The claim-admission audition proved that Lean can own the final ADMIT / REJECT decision while TypeScript supplies normalized semantic dependency identities.

This experiment attacks that remaining preprocessing boundary:

> Can Lean derive whether a semantic dependency has a usable identity from normalized upstream facts, lifecycle state, selector semantics, and settlement receipts without accepting a precomputed `semantic_identity` assertion?

This experiment does **not** audition cryptographic hashing. TypeScript may continue to compute SHA-256 or canonical digests over material that Lean has already selected. The semantic question is which upstream material is identity-bearing and whether that material is currently admissible.

## Frozen boundary

For every dependency, Lean receives:

- dependency kind and semantic selector;
- normalized upstream semantic-output material, if the upstream verifier exposes one;
- current upstream lifecycle, including the current run identity when applicable;
- normalized settlement receipt facts.

Lean must derive the semantic identity material used by claim admission.

Lean must **not** receive:

- `semantic_identity`;
- `semantic_identity_resolved`;
- `receipt_current`;
- `receipt_matches_lifecycle`;
- `upstream_output_available`.

Those are conclusions.

## Semantic selectors in scope

### `output / verified-content`

Resolution requires:

1. the upstream obligation exists;
2. the upstream lifecycle is DONE;
3. the upstream verifier exposes supported normalized output-identity material.

The result is typed semantic identity material selected from the upstream verifier semantics.

Cryptographic encoding of that material remains outside this experiment.

### `evidence / settlement-receipt`

Resolution requires:

1. the upstream obligation exists;
2. the upstream lifecycle is DONE;
3. the lifecycle names the current realized run;
4. a settlement receipt exists for that exact run;
5. the receipt belongs to the same upstream obligation;
6. its disposition is DONE;
7. it has a non-empty durable settlement commit.

The semantic identity material is the exact settlement commit bound to the current realized run.

## Null hypothesis

Keep semantic dependency identity derivation in TypeScript.

Lean earns this boundary only if all of the following hold:

1. **Differential parity:** Lean resolution agrees with the current TypeScript `obligationKey` semantics over the shared modeled cases.
2. **No trusted resolution bit:** precomputed `semantic_identity` is rejected or semantically inert.
3. **Exact run binding:** evidence identity cannot be borrowed from a stale or different run.
4. **Exact obligation binding:** a receipt for another obligation cannot satisfy the edge.
5. **Fail closed:** unsupported selectors, missing output material, missing run identity, malformed receipt state, duplicate receipt authority, or missing settlement commit do not resolve.
6. **Generic invariant:** machine-checked Lean theorems establish that claim admission implies every semantic dependency has derivable identity material.
7. **Boundary remains smaller than a provider adapter:** provider I/O, authenticated observation, canonical hashing, Git replay, and provider-specific raw parsing remain outside Lean.

If Lean requires provider transport logic or a duplicate hashing stack merely to reproduce the TypeScript result, TypeScript retains this boundary.

## Hostile cases fixed before implementation

The differential suite must include at least:

1. DONE file-output dependency resolves;
2. non-DONE file-output dependency does not resolve;
3. supported Kubernetes/GitHub normalized output material resolves;
4. missing normalized output material does not resolve;
5. DONE evidence dependency + exact current run + DONE receipt + settlement commit resolves;
6. receipt for stale historical run does not resolve;
7. receipt with wrong obligation does not resolve;
8. non-DONE receipt does not resolve;
9. receipt without settlement commit does not resolve;
10. duplicate receipt identity fails closed;
11. unsupported selector fails closed;
12. forged caller `semantic_identity` cannot turn an unresolved edge into a resolved one.

## Possible outcomes

- **TypeScript retains semantic identity derivation.**
- **Lean earns semantic identity-material derivation; cryptographic encoding remains TypeScript.**
- **Boundary is wrong:** semantic identity and hashing cannot be separated without introducing a second source of truth.

No broader language migration follows automatically.
