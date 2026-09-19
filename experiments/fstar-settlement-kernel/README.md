# F* settlement kernel experiment

## Question

Can a verified realization remain reusable across producers, obligation instances, and execution-authority rotations while settlement still requires exact current authority?

This is a bounded language experiment, not a proposal to rewrite Overcenter in F*.

## Corrected model

The original version of this experiment put semantic identity, obligation identity, revision, and authority generation into one `material_key`. That proved exact evidence binding, but it was too strong for the reuse claim: changing execution authority also invalidated the realization.

The corrected model separates three identities:

```text
semantic realization identity
  verifier version
  source input
  material config
  acceptance predicate
  semantic dependency closure
           │
           ▼
   verified realization
           │
           │ reusable across runs / producers /
           │ authority generations / obligation instances
           ▼

obligation instance
  obligation_id
  current revision
  current authority generation
           │
           ▼
 current settlement authority
           │
           ▼

verified realization + current settlement authority
                    │
                    ▼
                 settle
```

Producer provenance remains attached to the realization but is not part of semantic identity.

## Positive controls

The proof demonstrates all of the following:

- agent, human, and prior-run realizations with the same semantic key can settle the same obligation;
- a prior-run realization remains valid after revision and authority-generation rotation when semantic identity is unchanged;
- the same realization can satisfy a distinct obligation instance with the same semantic identity;
- settlement after either reuse case still requires a fresh authority value bound to the current obligation instance, revision, and authority generation.

The key distinction is:

```text
authority changes
    -> realization survives
    -> old authority dies
    -> fresh authority + old realization may settle

semantic input changes
    -> old realization dies
```

## Hostile controls

The hostile modules require F* to reject:

- authority for the wrong obligation instance;
- stale revision authority;
- stale authority generation;
- realization reuse after verifier change;
- realization reuse after source-input change;
- realization reuse after material-configuration change;
- realization reuse after acceptance-predicate change;
- realization reuse after semantic-dependency change.

This directly tests the split rather than merely documenting it.

## What success means

A green run supports this narrow claim:

> Semantic realization reuse and current execution/settlement authority can be represented as independent proof obligations. A realization may survive authority rotation or obligation-instance changes when semantic identity is exact, while settlement still cannot proceed without authority bound to the current obligation instance, revision, and generation.

That is stronger and more accurate than the original experiment's claim.

## What this does not prove

This experiment still does not prove that:

- Overcenter's TypeScript realization key contains every material semantic dependency;
- production authority values cannot be forged before validation;
- provider observations are truthful;
- an external-effect realization is safe to reuse as though it were a pure build artifact;
- the TypeScript kernel already implements this F* split.

Those remain separate production and provider boundaries.

## Run

With F* installed:

```sh
bash experiments/fstar-settlement-kernel/check.sh
```

CI pins the F* release archive and SHA-256 used for the hosted run.
