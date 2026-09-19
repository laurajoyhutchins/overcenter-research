# Lean-certified typed tensor projection

## Question

The Lean semantic stack now owns claim admission, semantic identity, obligation-key preimage construction, settlement, and current realization projection.

This experiment asks a different question:

> Can Lean expose the obligation graph as a canonical sparse typed tensor projection that an untrusted numerical consumer can analyze without becoming an authority over graph meaning?

The experiment does **not** ask whether tensors should replace the obligation graph, nor whether Python should own scheduling, settlement, reuse, or project truth.

## Frozen semantic slice

The source of truth is `RawClaimContext`.

Only the graph-structure slice is projected:

- obligation identity;
- dependency source/target;
- dependency semantic role.

The projection intentionally excludes:

- packet and postcondition payloads;
- semantic identity material;
- receipts;
- provider observations;
- realization truth;
- mutation authority;
- settlement decisions.

Lifecycle facts remain required only insofar as `RawClaimContext` structural validation requires them. They are not tensor features in this first experiment.

## Edge direction

For an obligation `consumer` declaring a dependency on `upstream`, the tensor contains:

```text
consumer --relation--> upstream
```

The adjacency tensor therefore uses:

```text
A[relation, consumer_index, upstream_index] = 1
```

## Relation universe

Version 1 has exactly three relation planes:

```text
0  control
1  semantic / verified-content
2  semantic / settlement-receipt
```

Same endpoints with different relation roles must remain distinct.

No provider-specific relation is permitted.

## Canonical sparse representation

Lean must derive a deterministic projection of the form:

```json
{
  "schema": "overcenter-lean-graph-tensor/v1",
  "view_key": "<canonical graph-view bytes>",
  "node_ids": ["..."],
  "edge_index": [[0, 1], [1, 2]],
  "edge_type": [1, 2]
}
```

`node_ids` are sorted by the language-independent lexical ordering already used by the repaired durable-key contract.

Edges are canonically sorted by source id, relation, and target id before numeric indexing.

The wire representation is sparse COO-like data. Dense materialization is a consumer concern.

## View binding

`view_key` is **not** an authority token and is not a cryptographic claim in this experiment. It is the exact canonical serialized graph-view bytes chosen by Lean.

An untrusted consumer must return the exact `view_key` with any proposed graph fact.

Lean must recompute the current graph view and reject a proposal when the supplied view key is stale.

A production version may digest these bytes, but hashing is deliberately excluded from this experiment so that tensor semantics are not confused with a hash implementation audition.

## Python consumer

The first Python consumer is intentionally tiny and untrusted.

It receives only the Lean tensor projection, constructs one adjacency matrix per relation plane, and computes typed two-hop reachability:

```text
A[r1] × A[r2]
```

It may propose:

```text
(source, target, r1, r2)
```

meaning that at least one intermediate node forms a two-hop path with those relation types.

Python does not decide whether the proposal is true.

Lean re-derives the graph from the current `RawClaimContext` and accepts the proposal only if:

1. the returned `view_key` exactly matches the current canonical graph view; and
2. the typed two-hop relation exists in the source graph.

## Null hypothesis

Do not create a tensor projection boundary.

A direct TypeScript graph traversal remains the control.

The tensor boundary earns further use only if all of the following hold:

1. **Canonicality.** Reordering obligations or dependency declarations does not change the tensor projection.
2. **Typed fidelity.** Control, verified-content, and settlement-receipt edges remain distinct.
3. **Completeness.** Every source dependency in the projected semantic slice appears exactly once in the tensor.
4. **No invented edges.** Every tensor edge corresponds to one source dependency.
5. **Index alignment.** Every emitted numeric endpoint refers to the exact canonical node id claimed by the source edge.
6. **Duplicate rejection.** Exact duplicate dependency records fail closed rather than changing tensor multiplicity.
7. **Reference safety.** Unknown upstream references fail closed.
8. **Consumer non-authority.** Python cannot make a false or stale two-hop claim pass Lean verification.
9. **Differential agreement.** Tensor-derived two-hop reachability agrees exactly with direct graph traversal for the hostile suite.
10. **No semantic creep.** No provider interpretation, realization truth, graph admission, mutation, or settlement authority moves into Python.

## Machine-checked obligations

The Lean implementation must establish generic properties stronger than fixture parity:

- successful tensor construction implies that every emitted tensor entry is index-aligned with the canonical node list;
- successful tensor construction binds the returned tensor to the canonical graph view represented by `view_key`;
- verification of a proposed two-hop fact requires an exact current view-key match and a real pair of typed source edges.

Finite hostile examples remain required in addition to these generic properties.

## Hostile cases fixed before implementation

At minimum:

1. obligations supplied in opposite declaration orders;
2. dependencies supplied in opposite declaration orders;
3. Unicode obligation ids whose lexical order is not safely modeled by locale collation;
4. exact duplicate dependency record;
5. same source and target with verified-content and settlement-receipt selectors;
6. same source and target with control and semantic relations;
7. unknown upstream reference;
8. a cycle, to prove tensorization represents structure rather than silently performing DAG admission;
9. forged numeric endpoint;
10. forged relation type;
11. Python proposal for a nonexistent two-hop path;
12. valid Python two-hop proposal;
13. proposal replayed after one dependency relation changes;
14. proposal replayed after an edge is removed;
15. declaration reordering with unchanged semantics and unchanged `view_key`;
16. direct TypeScript two-hop traversal and Python tensor multiplication produce the exact same candidate set.

## Interpretation

A positive result earns only this boundary:

```text
Lean semantic graph
       |
       v
canonical sparse typed tensor
       |
       v
untrusted numerical analysis
       |
       v
Lean verification of proposed facts
```

It does not by itself justify PyTorch, a GNN, learned scheduling, or ML-guided execution.

Those require a separate experiment demonstrating useful leverage over a plausible deterministic alternative.

## Possible outcomes

- **Projection succeeds.** The formally defined graph slice can safely cross into numerical tooling.
- **Projection is too lossy.** Required semantic distinctions cannot be represented without leaking authority or duplicating semantics.
- **Projection is too cumbersome.** Direct graph machinery is simpler and the tensor boundary is not justified.
