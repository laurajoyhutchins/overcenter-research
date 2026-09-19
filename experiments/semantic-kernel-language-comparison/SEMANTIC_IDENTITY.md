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


## Result

**Lean earns semantic dependency identity-material derivation at the normalized-source boundary.**

Evaluated implementation head:

`cd4d569a8878f6c030e5543b927c824fe818be0e`

Exact-head evidence:

- semantic identity audition, push run `35425071443`: **PASS**
- semantic identity audition, PR run `35425073635`: **PASS**
- parent Lean-vs-TypeScript claim admission, run `35425073628`: **PASS**
- existing Lean semantic-kernel proof, run `35425073746`: **PASS**
- repository Evidence, run `35425073693`:
  - fast deterministic regression: **PASS**
  - adversarial local proofs: **PASS**
  - TLA+ safety proof: **PASS**

The frozen decision rule was committed before implementation at
`65a4c5483831363a4fa9ccef859e2c4cb3c26719`.

### What moved into Lean

The caller no longer supplies semantic identity or a resolution boolean.

Lean now receives normalized source facts and derives identity-bearing material for:

- `file-content-equals/v1`;
- `eventually-consistent-file-content-equals/v1`;
- GitHub commit status;
- Kubernetes ConfigMap existence;
- exact settlement receipt identity.

For settlement evidence Lean independently binds:

```text
semantic edge
    ↓
upstream DONE lifecycle
    ↓
exact current run
    ↓
receipt for same run + same obligation
    ↓
DONE disposition + durable settlement commit
    ↓
semantic identity material
```

Stale-run receipts, wrong-obligation receipts, non-DONE receipts, missing settlement commits, duplicate receipt authority, unsupported selectors, missing source material, malformed lifecycle state, and caller-supplied `semantic_identity` all fail closed.

The proof layer establishes that `derivedClaimAdmissible = true` implies semantic inputs are resolved by this derivation and that the underlying proof-bearing claim-admission decision also accepts.

### Important trust boundary that remains

This experiment deliberately does not prove raw provider parsing or cryptographic primitives in Lean.

TypeScript still supplies normalized source primitives such as:

- SHA-256 of expected file content;
- canonical GitHub status context;
- validated provider coordinates and expected state.

TypeScript also still performs the final cryptographic encoding of Lean-selected material into the current identity string / canonical digest.

So the earned boundary is:

```text
authenticated provider / durable facts
             |
             v
TypeScript deterministic normalization
  - validate raw postcondition fields
  - SHA-256 primitive
  - provider canonicalization
             |
             v
Lean semantic identity derivation
  - selector meaning
  - lifecycle binding
  - current-run binding
  - receipt binding
  - identity-bearing material
             |
             v
TypeScript cryptographic encoding
             |
             v
Lean claim admission
```

This is materially stronger than the parent experiment's caller-provided `semantic_identity`, without turning Lean into a provider adapter or cryptography implementation.

### Interpretation

The null hypothesis loses for semantic identity **selection and binding**.

It does not lose for ordinary provider normalization or hashing.

The next useful falsifier is obligation-key construction: have Lean construct the complete canonical semantic key preimage, including sorted semantic dependencies, while leaving only the final SHA-256 primitive outside. That would test whether the truth-deciding core can absorb identity composition without absorbing infrastructure.

## Current-head confirmation

Exact evaluated revision `59fea88829fbfd09aa681165e9f5f4ddb87a361d` passed semantic-identity run `35425208329`, claim-admission audition `35425208320`, Lean kernel `35425208411`, and repository Evidence `35425208281`. Later documentation-only commits should cite this evaluated revision rather than silently treating branch HEAD as evidence identity.
