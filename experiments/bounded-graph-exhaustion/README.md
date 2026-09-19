# Bounded graph exhaustion experiment

## Question

Can Overcenter exhaustively check the small obligation-graph state space instead of relying only on hand-picked graph examples?

This experiment treats small graphs as a bounded model-checking surface. It does not claim that projects are limited to these sizes. The claim is narrower: structural bugs in graph validation, dependency reachability, lifecycle projection, or control-versus-semantic invalidation should usually admit a small counterexample.

## Coverage

The generator uses a fixed topological labeling, so every DAG has at least one generated representative. This is not one representative per isomorphism class; duplicates are harmless for the safety checks. A separate canonicalization pass verifies that the generated family contains every unlabeled DAG through five vertices.

The current bound is:

| surface | exhaustive bound | cases |
| --- | ---: | ---: |
| ordered DAG topology | 1-6 vertices | 33,867 graphs |
| every absent single-edge insertion | 1-5 vertices | 15,975 mutations |
| unlabeled DAG coverage check | 1-5 vertices | 1, 2, 6, 31, 302 classes |
| lifecycle projection | 1-4 vertices, 5 lifecycle assignments per vertex | 41,055 graph/state scenarios |
| typed dependency graphs | 1-4 vertices, each potential edge absent/control/semantic | 760 graphs |
| material output amendments | every vertex of every typed graph | 3,004 mutations |
| same-output packet amendment + resettlement | every vertex of every typed graph | 3,004 resumptions |

The bounds are deliberately asymmetric. Topology is cheap enough to push to six vertices. Full lifecycle assignment grows as `5^n`. Typed dependency graphs grow as `3^(n(n-1)/2)`, so four vertices already includes chains, forks, joins, diamonds, mixed edge kinds, and multi-hop semantic propagation without turning the test into a CI furnace.

## Independent oracles

The experiment does not merely ask the implementation whether it agrees with itself.

1. Reachability is compared with an independent Floyd-Warshall closure.
2. Every absent single-edge insertion is classified independently: adding `u -> v` is cyclic exactly when `v` already reaches `u`.
3. Lifecycle projection is compared with the small reference rule:
   - an existing realization exposes its lifecycle;
   - an unrealized obligation is `READY` iff every direct dependency is `DONE`;
   - otherwise it is `BLOCKED`.
4. Material output amendment is expected to invalidate exactly the amended obligation plus the transitive cone reachable through **semantic** edges. Control-only descendants must keep their prior semantic realization.
5. If an amendment changes only the packet and the amended obligation is resettled with the same verified output identity, all historical semantic descendants must become reusable again.

Production code under test includes `validateGraph`, `dependsOn`, `validateAdmission`, `obligationKey`, and `deriveProjectProjection`.

## Why this is useful

The experiment converts some architectural questions into bounded exhaustive claims:

```text
small legal graph
    ×
edge semantics
    ×
lifecycle facts
    ×
material amendment
        ↓
reference relation
        ↕ exact agreement
Overcenter projection
```

If a future edge kind, lifecycle state, or identity rule expands the semantic universe, this test should make that cost visible. New semantics should either extend the reference model and the exhaustive generator, or explicitly explain why the old bounded claim no longer applies.

## Non-claims

This does not prove arbitrary-size graph correctness, provider correctness, liveness, or the transaction/recovery protocol. Those remain separate evidence classes.

It also does not yet quotient the full typed/state space by graph isomorphism. The current bounds are small enough that exhaustive labeled-topological generation is simpler and less trusted than a sophisticated canonical graph generator.

## Run

```sh
npm run test:bounded-graph
```
