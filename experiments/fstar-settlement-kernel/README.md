# F* settlement kernel experiment

## Question

Can an Overcenter-like settlement boundary make stale or semantically mismatched evidence unrepresentable while allowing the same verified realization to be reused regardless of who produced it?

This is a bounded language experiment, not a proposal to rewrite Overcenter in F*.

## Model

The experiment separates **material identity** from **producer identity**.

```text
material key
  obligation id
  revision
  authority generation
  verifier version
  source input
  material config
  acceptance predicate
        │
        ▼
bound_evidence obligation
        │
        ▼
settle

producer = Agent | Human | PriorRun
        │
        └── deliberately not part of the material key
```

`bound_evidence o` is a refinement of raw `evidence`. It can only contain evidence whose material key is exactly the key required by `o`.

`validate` is the runtime boundary that attempts to upgrade raw evidence into bound evidence. `settle` accepts only bound evidence.

## Positive controls

`Positive.fst` establishes that the same material realization can satisfy the same obligation when attributed to:

- an agent;
- a human;
- a prior run.

It also reattributes already-bound evidence without invalidating it. This is the producer-independent reuse claim in miniature.

## Hostile controls

Each hostile file contains an `[@@expect_failure]` declaration. The module verifies only if F* rejects construction of the invalid `bound_evidence`.

The controls independently change:

- obligation identity;
- exact revision;
- authority generation;
- verifier version;
- source input;
- material configuration;
- acceptance predicate.

Producer identity is the deliberate counterexample: changing only the producer must remain valid.

## What success means

A green run supports this narrow claim:

> Once evidence has been refined against an exact material key, the settlement function cannot be called with evidence from a different obligation, revision, authority generation, verifier, source input, material configuration, or acceptance predicate without crossing an explicit unverified boundary.

The experiment also extracts the verified kernel to OCaml to make sure this is executable verified programming rather than a theorem-only artifact.

## What this does not prove

This experiment does not prove that:

- Overcenter's current TypeScript implementation satisfies the F* model;
- material keys are complete in production;
- provider observations are truthful;
- authority generations cannot be forged before validation;
- extracted unverified callers preserve F* refinements;
- concurrent mutation authority is separated.

Those require separate experiments. Pulse is the obvious next candidate for the concurrency/capability question if this one survives.

## Run

With F* installed:

```sh
bash experiments/fstar-settlement-kernel/check.sh
```

CI pins the F* release archive and SHA-256 used for the hosted run.
