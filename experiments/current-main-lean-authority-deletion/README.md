# Current-main Lean authority-deletion experiment

## Question

Should current Overcenter production code replace its TypeScript graph-validity
authority with the already-proved Lean semantic kernel?

This is deliberately narrower than asking whether Lean is fast in isolation.
That question has already been answered.

The production question is:

> Can Lean become the sole authority for one coherent current-main safety
> predicate while making the architecture smaller or stronger rather than
> creating a second implementation that must remain authoritative?

## Exact authorities

Current-main base:

`1f6ad04704b3ed594c58ad5a5759be5048c3843d`

Pinned Lean research implementation:

`0c5db60f2dc14af93f554fd9f870181261ce5f11`

The Lean reference remains an experimental input. This branch does not import
the old Lean lineage wholesale.

## Candidate predicate

The candidate is **graph validity**:

- every dependency names a known obligation;
- the obligation graph is acyclic.

This is the narrowest current-main predicate with an independently stated Lean
graph property and a compiled soundness theorem.

Provider-specific settlement semantics and semantic-selector interpretation stay
in TypeScript. Static effect conflict is intentionally excluded from the first
candidate because current main also uses that relation in defensive projection.

## Current TypeScript authority

At the frozen base:

- `src/admission.ts` calls `validateGraph(state)` before admitting a new
  definition/amendment;
- `src/projection.ts` calls `validateGraph(state)` while replaying each
  obligation fact;
- `src/projector.ts` contains a recursion-cycle guard while deriving semantic
  realizations.

A successful production replacement must not merely add Lean to the first call
site. New admission and historical replay must agree on the same graph truth.

The projector recursion guard may remain only as an invariant assertion over a
state already certified by the graph authority. It must not become an
independent fallback graph validator.

## Frozen acceptance criteria

The experiment earns a production runtime port only if all of these hold:

1. **Authority deletion**
   - TypeScript `validateGraph` can be removed from authoritative admission and
     replay paths.
   - No TypeScript graph validator remains as a co-authority.

2. **Facts, not conclusions**
   - Lean receives obligation IDs and dependency edges.
   - The caller may not provide `acyclic=true`,
     `dependencies_known=true`, or an equivalent precomputed conclusion.

3. **Historical replay remains exact**
   - Every intermediate obligation-definition state remains validated.
   - The experiment may not validate only the final graph, because that would
     accept histories containing an invalid intermediate state.

4. **No durable-schema rescue**
   - The result must not require storing a new graph-validity certificate in
     durable history merely to make the runtime integration practical.

5. **Drop-in replay cost**
   - Model current replay by validating every prefix of a valid 100-obligation
     chain.
   - A synchronous one-process-per-validation Lean replacement must add no more
     than **500 ms total** over the TypeScript baseline for that 100-commit
     replay.
   - This threshold is frozen before measurement. It is intentionally generous
     relative to ordinary in-process graph validation.

6. **No hidden daemon requirement**
   - A persistent Lean process is measured diagnostically.
   - If persistent Lean is acceptable but one-shot Lean fails, the experiment
     does **not** automatically pass. A daemon/process-lifecycle architecture is
     a different production design and requires its own justification.

7. **Behavioral parity**
   - Every replay prefix must be accepted by TypeScript and Lean.
   - Hostile unknown-dependency and cycle fixtures must fail closed.

## Why benchmark cumulative replay

Current replay validates graph structure after each obligation fact is applied.
The relevant cost is therefore not one 1,000-node decision in isolation:

```text
definition 1  -> validate graph prefix 1
definition 2  -> validate graph prefix 2
...
definition N  -> validate graph prefix N
```

A runtime replacement that is cheap once but expensive when rebuilding history
is not a drop-in replacement for current architecture.

## Interpretation

A failure is useful.

If the one-shot boundary fails but persistent Lean succeeds, that means the Lean
semantic technology remains viable while the **current integration seam does
not**. The next experiment would then be an embedded/native-library or
certificate-carrying boundary, not an immediate production port.

Do not weaken these criteria after observing the result.
