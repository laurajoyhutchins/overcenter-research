# Recovery agent refinement

## Historical result

This post-hoc bounded-refinement experiment produced a **mixed** result.

At exact evaluated revision `643045db41ed1c912f3a46aa3ce879310391207e`:

- deterministic baseline: **4 / 7**;
- frozen one-shot round: **3 / 7**;
- round two alone: **4 / 7**;
- cumulative two-round recovery: **4 / 7**;
- refinement gain: **+1**;
- gain over deterministic baseline: **0**;
- false certainty: **0**;
- permanent-uncertainty violations: **0**.

Hosted evidence: GitHub Actions run `35759275101`, result artifact `10709196620`.

## Boundary

Round one is the exact retained negative candidate from the one-shot experiment. Trusted software exposed only cardinality feedback: `zero`, `one`, `many`, or `not-searched`. One fresh reasoning call could make a second and final read-only proposal.

Provider records, effect digests, certainty, retries, mutation, and settlement remained outside the model. A cardinality of `one` was explicitly not settlement evidence.

The refinement repaired one model miss, but inference still did not beat deterministic recovery yield. Generalization would require a held-out corpus.

## Reproduce

Check out exact revision `643045db41ed1c912f3a46aa3ce879310391207e`, then run:

```sh
npm run test:recovery-agent-refinement
```

Executable/model scaffolding is historical and is not retained on current main.
