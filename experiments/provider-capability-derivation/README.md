# Provider capability derivation bridge

## Question

Can Overcenter derive concurrency-relevant capability footprints from real provider semantics rather than hand-constructing scheduler conflict keys?

## Result

Yes, with two independent dimensions:

```text
physical mutation overlap
          ×
provider equivalence witness
```

The provider-neutral core derives `EffectSemantics`:

```text
resource
desired
```

The provider adapter separately issues an `EffectEquivalenceWitness` when it can justify same-resource unordered execution under one exact provider contract.

The pair classification is therefore:

```text
different resource
    -> parallel-disjoint

same resource
+ same witness identity
    -> parallel-adapter-commutative

same resource
+ missing/different witness
    -> ordered-conflict

missing effect semantics
    -> unknown
```

`unknown` is not promoted into a concurrency guarantee.

## GitHub status coordinate

GitHub commit-status resource identity is derived by production provider code from:

```text
stable repository_id
+ exact commit_sha
+ normalized status context
```

Repository owner/name is not part of the physical resource identity. A v2 repository rename therefore preserves the coordinate when stable repository identity is unchanged.

## Witness identity

Compatibility no longer comes from `sameDesiredCommutes: boolean`.

The GitHub adapter issues a version-bound witness containing the provider/verifier contracts, coordinate contract, observation contract, mutation operation contract, semantic operation, and digests of the relevant semantics.

Consequences:

- identical v1 GitHub status writes can remain unordered;
- identical v2 writes can remain unordered;
- v1 and v2 writes to the same coordinate do **not** inherit equivalence merely because resource and desired state match;
- incompatible desired states require graph ordering.

## Admission agreement

The experiment cross-checks all classifications against production `validateAdmission`.

The important invariant is now:

```text
provider derives meaning
       ↓
provider issues witness
       ↓
generic admission compares witness identity
```

Generic admission does not reproduce GitHub normalization or compatibility rules.

## Run

```sh
npm run test:capability-derivation
```
