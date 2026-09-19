# Categorical graph laws experiment

## Question

Do useful category-theoretic laws actually describe Overcenter's graph semantics, or are they only suggestive notation?

This experiment tests three concrete claims against bounded executable models.

## Results encoded by the tests

### 1. Thin-category factorization: falsified

A dependency DAG and its transitive closure have the same reachability preorder, but Overcenter can distinguish them.

Minimal counterexample:

```text
n0 -> n1 -> n2
```

Settle `n0` and `n1`, leave `n2` unrealized, then materially amend `n0`.

In the original chain, `n1` remains historically DONE because control edges do not enter its semantic identity, so `n2` is READY.

Add the transitive control edge `n0 -> n2` without changing reachability. Now `n2` is BLOCKED because its direct dependency `n0` reopened.

So current project semantics do **not** factor through the thin reachability category. Direct control generators remain observable to execution eligibility.

The same experiment also checks that `n2`'s semantic key is unchanged. This cleanly separates execution eligibility from semantic identity.

### 2. Control subdivision: semantic identity invariant

Replace one direct control edge

```text
A -> B
```

with

```text
A -> X -> B
```

where `X` is a new control-only obligation.

Across every typed graph through four original vertices, every original obligation retains the same semantic key. The bounded space contains 4,165 typed graphs and 6,193 individual control-edge subdivisions.

This is a real forgetful law: semantic identity ignores the presentation of control-only paths, even though execution eligibility does not.

### 3. Disjoint union: componentwise projection invariant

For every pair drawn from all one- and two-node control DAGs and all five lifecycle assignments per node, project each component separately and then project their disjoint union.

For all 3,025 pairs, each obligation keeps the same:

- public status;
- semantic key;
- claimability result;
- structured explanation.

The global `readyWork` selector deliberately does not decompose: two independent components can each have a local READY choice while their union exposes one lexicographically selected `readyWork`.

So project truth is componentwise under disjoint union; the single scheduling choice is global policy layered above it.

## Interpretation

The experiment rejects the strongest categorical story.

```text
dependency DAG
   |
   +--> execution eligibility  -- observes direct control generators
   |
   +--> semantic identity      -- forgets control-path presentation
   |
   +--> component projection   -- decomposes over disjoint union
   |
   +--> readyWork choice       -- global scheduler selection
```

That is more useful than declaring one monolithic "graph category." Different Overcenter semantics preserve different amounts of structure.

## Non-claims

These are bounded executable results, not arbitrary-size proofs and not yet a formal categorical specification.

In particular, the experiment does not establish a category of typed dependencies, a natural transformation between implementations, or a monoidal structure for every kernel surface. Those terms should only be adopted where the corresponding laws are defined and proved.

## Run

```sh
npm run test:categorical-graph-laws
```
