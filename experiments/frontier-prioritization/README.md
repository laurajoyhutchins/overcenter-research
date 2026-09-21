# Deterministic frontier prioritization

## Question

When several graph nodes are simultaneously admissible and the next choice looks ambiguous, how often can deterministic software settle the priority before an AI agent is consulted?

This experiment treats **"ambiguous" as a hypothesis to falsify**, not as evidence that reasoning is required.

## Boundary

The modeled problem is intentionally narrow:

- the dependency graph is authoritative and acyclic;
- objectives are machine-readable predicates represented by sets of nodes that can satisfy them;
- resolving one node costs one prioritization step;
- the desired next choice is any choice that preserves the minimum number of remaining selections to objective completion.

Only **reachable, dependency-closed project states** are evaluated. A node cannot appear resolved while one of its prerequisites is unresolved.

If the objective semantics themselves are not machine-readable, this experiment says nothing about that missing judgment. It tests graph-node prioritization after semantics are explicit.

## Oracle-equivalent choice sets

The exact oracle returns the complete set of next choices that preserve optimal downstream cost. It never manufactures ambiguity by nominating one arbitrary winner.

A nontrivial frontier is classified as:

- **equivalent**: every admissible choice is oracle-equivalent;
- **resolved**: every choice preferred by the cheap deterministic policy is oracle-equivalent;
- **ambiguous**: its top set contains both optimal and suboptimal nodes;
- **wrong**: it has one unique top choice and that choice is suboptimal.

## Cheap structural feature ladder

The proposal heuristic is lexicographic and weight-free:

1. number of unsatisfied objectives for which a candidate is the only current frontier route;
2. number of objectives it directly satisfies;
3. number of unsatisfied objectives reachable through it;
4. immediate objective satisfiers it newly admits;
5. nearest objective distance;
6. total objective distance.

Every signal is derived from graph/objective state.

## Exhaustive reachable-state result

The bounded corpus contains:

- all 543 labeled four-node DAGs with every nonempty one-objective placement;
- all 25 labeled three-node DAGs with every pair of nonempty two-objective placements;
- every **reachable** nonterminal state with at least two READY nodes.

That yields **7,395 nontrivial frontier states**.

| deterministic policy | equivalent | resolved | ambiguous | uniquely wrong |
| --- | ---: | ---: | ---: | ---: |
| objective reachability | 2,389 | 3,458 | 1,548 | 0 |
| + necessity / directness / distance | 2,389 | 4,934 | 72 | 0 |
| + immediate objective unlock | 2,389 | 5,006 | **0** | **0** |

Every modeled small-graph ambiguity is therefore either mechanically equivalent or resolved to an oracle-equivalent choice before AI.

## The exact verifier should not search execution order

The first exact fallback used subset-state dynamic programming. Its worst-case upper bound looked like `2^n` in graph nodes.

That is the wrong state space.

For a formal objective, a successful completion is a dependency-closed set containing a satisfier for every unresolved objective. The replacement verifier therefore searches **objective satisfier choices and their prerequisite closures**:

```text
objective satisfier
        ↓
prerequisite closure
        ↓
union with other objective closures
        ↓
minimum additional resolved-node set
        ↓
oracle-equivalent READY choices
```

It ignores READY distractors that cannot contribute to an objective.

The new closure verifier is cross-checked against the old subset-state oracle on every reachable state in the exhaustive corpus. Their minimum costs and complete optimal-choice sets must match exactly.

## Larger adversarial sample

A fixed deterministic sample covers 1,200 DAG/objective problems with:

- 5 through 10 nodes;
- edge densities 0.15, 0.30, and 0.50;
- one through three objectives;
- every reachable nontrivial frontier state.

Across **15,574** such frontier states:

| classification | states |
| --- | ---: |
| mechanically equivalent | 1,814 |
| cheap heuristic resolves oracle-equivalently | 13,648 |
| detectable top-set ambiguity | 53 |
| unique heuristic miss | 59 |

The cheap heuristic is therefore oracle-equivalent in **99.28%** of reachable nontrivial frontiers.

The 112 residuals are all sent to the closure verifier. Across all 112:

- total closure-search states explored: **416**;
- mean: **3.71**;
- maximum: **7**.

So none of these residuals comes remotely close to justifying AI escalation.

## Solver ladder

The exact closure search is itself treated as something to optimize rather than an excuse to escalate.

Four deterministic stages are measured independently:

1. **raw closure search**: enumerate objective-satisfier prerequisite closures;
2. **kernelization**: remove redundant objectives, prune dominated closure supersets, and propagate forced closures;
3. **interaction decomposition**: split objective sets whose possible prerequisite closures cannot share selected nodes;
4. **branch-and-bound**: seed an incumbent greedily, then prune with two certified lower bounds:
   - a packing bound over mutually noninteracting objective universes;
   - a coverage-capacity bound over how many unresolved objectives any remaining nodes can satisfy.

Representative exact state counts:

| instance | raw | + kernel | + decomposition | + bounds |
| --- | ---: | ---: | ---: | ---: |
| 12 objectives with dominated prerequisite alternatives | 1,217 | 13 | **0** | **0** |
| 12 independent objectives, two alternatives each | 8,191 | 8,191 | 36 | **12** |
| connected 20-objective cycle | 7,714 | 7,676 | 7,676 | **1** |

These are ablations, not three specially selected production workloads. Each isolates a different source of avoidable combinatorics.

The solver uses arbitrary-width BigInt masks for this layer, so graph size is no longer limited by the 32-bit masks used by the tiny exhaustive oracle. A **200-node / 100-objective independent** instance solves in exactly 100 bounded search states after decomposition.

A fixed connected stress case with **80 nodes and 50 interacting objectives** requires 248 bounded search states. That test remains in the normal deterministic experiment lane; wall-clock time is deliberately not an acceptance criterion.

A harder deterministic **100-node / 60-objective connected** case requires **16,797** bounded search states. It is deliberately excluded from ordinary CI and is available as:

```sh
npm run bench:frontier-prioritization
```

This gives the experiment a visible knee without turning every PR head into a solver stress run.

The optimized solver is still verified against the original subset-state oracle on every reachable state in the exhaustive small corpus. Optimization cannot change the minimum cost or the complete oracle-equivalent next-choice set.

## What actually makes the verifier hard?

Controlled cases separate graph size from objective combinatorics.

Adding irrelevant nodes to a two-node objective chain:

```text
distractors:       0   4   8   16   24
search states:     2   2   2    2    2
```

Increasing a forced objective chain from one to 24 nodes also remains at **2 search states**.

But independent objectives with two alternatives each produce:

```text
objectives:        1    2    3    4    5     6     7     8      9      10
search states:     3    7   15   31   63   127   255   511   1023    2047
```

The combinatorial boundary is therefore **objective alternatives and overlap**, not raw graph size.

This is not an artifact of the verifier implementation. With no dependency edges, the formal problem already contains minimum hitting set: choose the smallest set of nodes that intersects every objective's satisfier set. Exact optimization is therefore combinatorial in the general case.

## Deterministic budget before AI

The architecture under test is now:

```text
authoritative graph + formal objective
              ↓
cheap structural proposal
              ↓
closure-based exact verifier
              ↓
within deterministic budget?
        ┌─────┴─────┐
       yes          no
        ↓            ↓
certified node   objective/search semantics
                may require another deterministic
                optimizer or, only then, AI judgment
```

A search-budget miss is **not automatically an AI problem**. It first says the exact optimizer needs a better deterministic algorithm, decomposition, approximation certificate, or explicit project policy.

AI belongs only after deterministic possibilities are exhausted or the missing information is genuinely semantic.

## Reproduce

No network, model, randomness, or external dependency is required. The larger corpus uses a fixed `XorShift32(0xC0FFEE)` generator.

```sh
node --test experiments/frontier-prioritization/frontier-prioritization.test.mjs
```

## Success criteria

The experiment is positive only if:

1. only dependency-closed reachable states are evaluated;
2. every modeled nontrivial frontier is compared with the complete oracle-equivalent choice set;
3. every heuristic feature is mechanically derived;
4. the final heuristic leaves zero ambiguity and zero misses in the exhaustive small corpus;
5. the fixed 5–10 node sample retains at least 99% oracle-equivalent heuristic coverage;
6. every larger-sample residual is exactly certified by the closure verifier;
7. closure verification exactly matches subset-state dynamic programming throughout the exhaustive reachable corpus;
8. irrelevant width and forced depth do not inflate closure-search state count in the controlled cases;
9. objective-alternative scaling remains visible rather than hidden by a flattering aggregate.

## Interpretation

The result supports:

> **Multiple READY nodes are not an AI prioritization problem. Deterministic graph features settle almost all modeled cases cheaply, and exact verification should search formal objective alternatives rather than execution order.**

The practical scaling limit is driven by formal objective combinatorics, not graph size. Even reaching that limit does not automatically authorize an AI call; it is first a deterministic optimization problem.

## Future research

Further exact-optimization work is deliberately out of scope for this experiment. Plausible follow-ons include:

- a Pseudo-Boolean, SAT, CP-SAT, or MILP reference solver behind the same certification interface;
- incremental solving across successive settled graph states;
- fixed-parameter or treewidth-aware decomposition of the objective-interaction kernel;
- weighted node cost, latency, risk, and resource constraints;
- adversarial generators targeted specifically at the connected-kernel stress boundary.

None of these is required to support the current claim or to merge this experiment.

## Non-claims

This experiment does not claim that:

- the current heuristic tuple is globally optimal;
- the closure verifier is polynomial in arbitrary objective systems;
- every real software objective is machine-readable;
- equal node-selection cost is an adequate production utility model;
- all combinatorial optimization should be solved by brute force;
- a heuristic result should be trusted without deterministic verification;
- no software-engineering task ever requires AI judgment.
