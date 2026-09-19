# Research map

The individual notes are prior-art lenses, not independent competing architectures.

Start with:

1. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — canonical cross-note architecture and glossary.
2. [`claims.md`](./claims.md) — separates safety, liveness, provenance, and reuse claims.
3. [`durable-execution-comparison.md`](./durable-execution-comparison.md) — Temporal, Restate, DBOS, AWS, and the boundary between durable replay and authoritative project truth.

Then use the detailed notes for the specific invariant they contribute:

| Note | Main question it answers |
| --- | --- |
| [Bazel / Nix graph derivation](./bazel-nix-graph-derivation.md) | What is an obligation, a realization, and a valid reuse identity? |
| [CALM / monotonic state](./calm-monotonic-state.md) | Which facts can accumulate without coordination, and where is synchronization actually required? |
| [Distributed fencing](./distributed-fencing.md) | How are stale execution authority and stale project state rejected independently? |
| [FoundationDB transaction semantics](./foundationdb-transaction-semantics.md) | How should Overcenter distinguish conflict from unknown mutation outcome and place the validation/commit boundary? |
| [Git transaction substrate](./git-transaction-substrate.md) | How little durable shared authority is sufficient for the prototype? |
| [Kubernetes / Flux reconciliation](./kubernetes-flux-reconciliation-prior-art.md) | How should desired state, observed state, reconciliation, generations, and conditions influence the outer loop? |
| [Kubernetes observation semantics](./kubernetes-observation-semantics.md) | Can structural certificates carry provider identity, complete snapshots, authoritative absence, and WATCH continuity across a second provider? |
| [Provider observation reuse](./provider-observation-reuse.md) | Which observation/certificate mechanics actually generalize across GitHub and Kubernetes without flattening provider meaning? |
| [Petri nets / workflow correctness](./petri-nets-workflow-correctness.md) | What structural graph properties can be proven mechanically, especially across amendments? |
| [TLA+ formal kernel](./tla-formal-kernel.md) | What is the smallest state machine that captures authority, uncertainty, replay, verification, and settlement safety? |
| [Transition attestations](./transition-attestations.md) | What evidence should survive after execution machinery is discarded? |
| [Absence evidence certificates](./absence-evidence-certificates.md) | How should provider-specific negative evidence carry subject, scope, snapshot, completeness, and provenance without collapsing to a boolean? |
| [Evidence-backed deduplication](./evidence-backed-deduplication.md) | When should parallel experimental implementations collapse to one production owner, and when is duplication still valuable evidence? |

The synthesis is deliberately selective:

```text
Bazel / Nix      -> obligation identity + reuse
CALM             -> monotonic proof facts
fencing          -> stale-authority rejection
FoundationDB     -> validate/settle + unknown outcomes
Git              -> minimal CAS authority experiment
Kubernetes/Flux  -> reconciliation projections
Petri nets       -> graph soundness / amendment rules
TLA+             -> safety kernel
attestations     -> durable proof
absence certs    -> provenance-bearing replay authority
durable runtimes -> execution survival, not final project-truth authority
```

Overcenter should borrow the invariant each body of prior art is good at without turning into a clone of any one of them.
