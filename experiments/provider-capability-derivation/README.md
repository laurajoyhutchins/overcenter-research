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
3. whether identical operations on that coordinate commute.

The bridge therefore derives two axes rather than collapsing them into one opaque capability key:

```text
postcondition
     │
     ▼
production effectSemantics
     │
     ├── physical_resource
     ├── semantic_operation
     └── same_operation_commutes
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
+ both adapters assert commutativity
        -> parallel-commutative

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

The experiment does not copy GitHub normalization logic. It calls `effectSemantics` and tests the resulting coordinate, including case-insensitive status-context identity.

## Agreement with current admission

The experiment cross-checks the derived relation against `validateAdmission`:

- disjoint GitHub status coordinates are accepted unordered;
- same coordinate + same desired state is accepted unordered because the adapter currently marks it commutative;
- same coordinate + incompatible desired state is rejected unordered;
- the same incompatible pair is accepted when a control dependency orders it.

This means the derivation describes the live core rather than a parallel toy policy.

## Important falsification of the first Pulse simplification

The bridge exposes a real limitation in the first Pulse experiment.

A single exclusive `pts_to` resource correctly models:

- disjoint coordinates;
- incompatible same-coordinate effects that require sequencing.

It does **not** model Overcenter's current claim that two identical GitHub status writes to the same coordinate commute.

So the production-relevant model is not merely:

```text
resource overlap? yes/no
```

It is:

```text
physical overlap
        ×
semantic compatibility
```

That is useful falsification, not a failure of the Pulse result. The Pulse result proved what exclusive mutation ownership implies. This bridge identifies where Overcenter intentionally relies on a stronger provider-specific commutativity claim.

## Architectural warning

`sameDesiredCommutes` is currently a boolean in `EffectSemantics`.

That is enough to express the existing GitHub experiment, but it is weak evidence for a future authority boundary. If concurrent same-coordinate effects become production-significant, the boolean should probably become a provider-derived commutativity witness/certificate with enough provenance to answer:

- which provider operation is being claimed commutative;
- under which canonical coordinate semantics;
- for which operation identity;
- under which adapter/version contract.

The experiment deliberately does not make that production refactor yet.

## Run

```sh
node --experimental-strip-types --test \
  experiments/provider-capability-derivation/capability.test.ts
```
