# Provider capability derivation bridge

## Question

Can Overcenter derive concurrency-relevant capability footprints from its real provider effect semantics instead of hand-constructing the resources used by the Pulse proof?

## Resulting model

The first Pulse experiment intentionally used a simpler model:

```text
different exclusive resources -> parallel
same exclusive resource        -> ordered
```

The live GitHub status adapter is more expressive. Its production `effectSemantics` already distinguishes:

1. the canonical **physical mutation coordinate**;
2. the requested **semantic operation**;
3. whether repeating the same desired operation is treated as commutative by the adapter's settlement semantics.

The third item is intentionally narrower than “the provider's physical history is identical.” Posting the same GitHub commit status twice can still create two provider records. The current Overcenter claim is that those writes are equivalent for the postcondition semantics that matter to admission and settlement.

The bridge therefore preserves both physical overlap and adapter-level semantic compatibility:

```text
postcondition
     │
     ▼
production effectSemantics
     │
     ├── physical_resource
     ├── semantic_operation
     └── sameDesiredCommutes
               │
               ▼
       pair classification
```

The pair classification is:

```text
different physical resource
        -> parallel-disjoint

same physical resource
+ same semantic operation
+ both adapters assert settlement-level commutativity
        -> parallel-adapter-commutative

same physical resource
+ incompatible/non-commutative operation
        -> ordered-conflict

missing effect semantics
        -> unknown
```

`unknown` is deliberately not treated as safe parallelism.

## GitHub status coordinate

For the current GitHub commit-status adapter, the physical coordinate is derived by the production semantics code from:

```text
repository_id
+ exact commit_sha
+ normalized status context
```

The experiment does not copy GitHub normalization logic. It calls `effectSemantics` and tests the resulting coordinate.

The hostile identity checks include:

- status-context case folding;
- repository identity changes;
- exact commit changes;
- context changes;
- GitHub v2 repository renames, which must not change capability identity because stable `repository_id`, not mutable owner/name, is authoritative.

## Agreement with current admission

The experiment cross-checks the derived relation against `validateAdmission`:

- disjoint GitHub status coordinates are accepted unordered;
- same coordinate + same desired state is accepted unordered because the adapter currently marks it commutative under Overcenter's semantics;
- same coordinate + incompatible desired state is rejected unordered;
- the same incompatible pair is accepted when a control dependency orders it.

This means the derivation describes the live core rather than a parallel toy policy.

## Important falsification of the first Pulse simplification

The bridge exposes a real limitation in the first Pulse experiment.

A single exclusive `pts_to` resource correctly models:

- disjoint coordinates;
- incompatible same-coordinate effects that require sequencing.

It does **not** model Overcenter's current adapter-level claim that two identical GitHub status writes to the same coordinate may remain unordered.

So the production-relevant model is not merely:

```text
resource overlap? yes/no
```

It is:

```text
physical overlap
        ×
settlement-level semantic compatibility
```

That is useful falsification, not a failure of the Pulse result. The Pulse result proved what exclusive mutation ownership implies. This bridge identifies where Overcenter relies on an additional provider-specific equivalence claim.

## Architectural warning

`sameDesiredCommutes` is currently a boolean in `EffectSemantics`.

That is enough to express the existing GitHub experiment, but it is weak evidence for a future authority boundary. If same-coordinate concurrency becomes production-significant, the boolean should probably become a provider-derived commutativity witness/certificate with enough provenance to answer:

- which provider operation is being claimed equivalent;
- under which canonical coordinate semantics;
- under which observation/settlement semantics;
- for which operation identity;
- under which adapter/version contract.

The experiment deliberately does not make that production refactor yet.

## Run

```sh
node --experimental-strip-types --test \
  experiments/provider-capability-derivation/capability.test.ts
```
