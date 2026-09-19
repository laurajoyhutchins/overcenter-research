> **Corrected by PR #69.** This experiment remains reproducible evidence for exact evidence binding, but its original material key incorrectly included current revision/authority generation and therefore does **not** establish producer-independent realization reuse. PR #69 separates reusable semantic realization identity from current settlement authority. Treat the stronger reuse interpretation below as superseded; the exact-evidence-binding result remains valid.

# F* settlement kernel experiment

## Question

Can an Overcenter-like settlement boundary make stale or semantically mismatched evidence unrepresentable while allowing the same verified realization to be reused regardless of who produced it?

This is a bounded language experiment, not a proposal to rewrite Overcenter in F*.

## Model

The experiment separates **material identity** from **producer provenance**.

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

producer provenance = Agent | Human | PriorRun
        │
        └── preserved on evidence, but deliberately not part of the material key
```

`bound_evidence o` is a refinement of raw `evidence`. It can only contain evidence whose material key is exactly the key required by `o`.

`validate` is the runtime boundary that attempts to upgrade raw evidence into bound evidence. `settle` accepts only bound evidence and preserves the producer recorded on that evidence.

## Positive controls

`Positive.fst` constructs three independently sourced witnesses with the same material key:

- agent-produced evidence;
- human-produced evidence;
- prior-run evidence.

All three satisfy the same obligation. Producer provenance is not rewritten to demonstrate reuse; it is retained on the evidence and copied into the settlement result. This keeps "producer-independent satisfaction" separate from "provenance may be falsified."

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

Producer identity is the deliberate counterexample: distinct producers with the same material key remain valid evidence for the same obligation.

## What success means

A green run supports this narrow claim:

> Once evidence has been refined against an exact material key, the settlement function cannot be called with evidence from a different obligation, revision, authority generation, verifier, source input, material configuration, or acceptance predicate without crossing an explicit unverified boundary.

It separately supports the narrower reuse claim that evidence from different producers can satisfy the same obligation when every material component is identical, without discarding the original producer provenance.

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
