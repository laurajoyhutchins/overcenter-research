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


## Final result

**The Lean-certified typed tensor projection succeeds.**

The experiment contract was frozen before implementation at:

`be56d008adbbd1906708445cd216b009ef5b02cd`

Evaluated implementation head:

`52e530e6aaed7e244311f6d06971da8c88a0d2c7`

Exact-head evidence:

- typed tensor projection push run `35428316334`: **PASS**;
- typed tensor projection PR run `35428318588`: **PASS**;
- parent realization projection run `35428318629`: **PASS**;
- parent semantic identity run `35428318602`: **PASS**;
- parent obligation-key preimage run `35428318683`: **PASS**;
- parent claim-admission run `35428318675`: **PASS**;
- existing Lean semantic-kernel proof `35428318607`: **PASS**;
- repository Evidence `35428318594`: **PASS**.

### What was established

The graph-structure slice of `RawClaimContext` can cross a formally constrained boundary as a canonical sparse typed tensor without moving graph meaning or project truth into the numerical consumer.

The emitted representation preserves the three frozen dependency roles:

```text
A[0, consumer, upstream] = control
A[1, consumer, upstream] = semantic / verified-content
A[2, consumer, upstream] = semantic / settlement-receipt
```

The hosted differential established:

- obligation declaration order does not affect the canonical projection;
- dependency declaration order does not affect the canonical projection;
- Unicode node ordering agrees with the language-independent control;
- identical endpoints with different relation roles remain distinct;
- exact duplicate dependencies fail closed;
- unknown upstream references fail closed;
- cycles remain representable rather than being silently turned into graph-admission policy;
- forged tensor coordinates and forged relation codes are rejected by the Python consumer;
- Python matrix composition and direct TypeScript traversal produce the same typed two-hop candidate set;
- Lean rejects nonexistent two-hop proposals;
- Lean rejects proposals bound to a stale graph view;
- callers cannot inject trusted projection fields into the projection command.

### Machine-checked boundary

The implementation now constructs a proof-carrying `CertifiedGraphTensor ctx`.

Lean establishes generically that:

1. a certified projection is index-aligned with its canonical node list;
2. a certified projection's `viewKey` is exactly the canonical graph-view serialization of the current `RawClaimContext`;
3. a successful plain projection inherits those properties from the certificate;
4. an accepted typed two-hop proposal is accompanied by a successful current projection and the exact boolean conjunction of current-view equality plus a real typed two-hop path.

The numerical consumer therefore proposes facts. It does not establish them.

### Findings during falsification

The first hosted attempts failed before the semantic differential:

- Lean 4.34 did not provide the assumed `List.get?` surface, so index lookup was made explicit;
- the original after-the-fact proof scaffolding was brittle, so the projection was strengthened into a proof-carrying structure;
- the protocol needed an explicit `Nat -> Json` coercion;
- the first differential compared the full verification envelope to a payload that intentionally omitted the schema tag.

These were implementation and harness defects, not exceptions to the frozen semantic contract. After repairing them, the exact frozen hostile suite passed without weakening the admission rule.

### Earned boundary

This experiment earns:

```text
Lean semantic graph
       |
       v
canonical sparse typed tensor
       |
       v
untrusted numerical search
       |
       v
candidate facts
       |
       v
Lean verification
```

It does **not** establish that Python or tensor machinery is useful enough to keep in production.

The next experiment must answer that separate question by comparing a learned or tensor-native adversarial searcher against plausible deterministic and random controls under the same Lean-execution budget.
