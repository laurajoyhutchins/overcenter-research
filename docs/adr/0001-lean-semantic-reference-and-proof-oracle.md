# ADR 0001: Lean is an executable semantic reference and proof oracle

- Status: Accepted
- Date: 2026-09-19
- Scope: semantic verification and production-runtime boundaries

## Context

Overcenter uses deterministic software to own execution correctness. Some of the
most dangerous deterministic decisions are small enough to state independently
of the surrounding runtime:

- dependency-graph validity;
- causal ordering of conflicting effects;
- exact semantic reuse;
- settlement admissibility;
- other finite safety predicates over normalized facts.

The Lean experiments demonstrated two different things:

1. Lean can express and prove useful properties about these predicates.
2. A runtime integration can still be the wrong architecture even when the Lean
   decision procedure is correct and fast in isolation.

The current-main authority-deletion experiment measured historical replay rather
than one isolated decision. Replaying 100 obligation-definition prefixes took
about 14.5 ms with the current TypeScript graph validator, about 3.7-3.8 seconds
when each validation launched a fresh Lean process, and about 79-82 ms through a
persistent Lean process.

That result rejects the obvious per-decision subprocess integration. A persistent
Lean authority process remains technically possible, but would add lifecycle,
restart, version-fencing, IPC, deployment, and failure semantics to a path that
is currently synchronous and pure.

The same experiment also showed why simply invoking Lean from new-work admission
would be architecturally wrong: graph truth is also consumed during exact
historical replay. Keeping TypeScript authoritative there while adding Lean to
admission would create two semantic authorities rather than delete one.

## Decision

Lean is an **executable semantic reference and proof oracle**, not a production
control-plane runtime dependency.

For selected critical predicates:

1. Lean states the intended semantic property independently.
2. Lean may provide a proved executable reference decision procedure.
3. Production TypeScript remains free to use a different implementation chosen
   for operational simplicity and performance.
4. CI compares the production implementation against the pinned Lean reference
   on exhaustive or generated bounded cases.
5. A semantic change must either:
   - continue agreeing with the existing oracle; or
   - deliberately amend the semantic specification, proof obligations, oracle
     identity, and associated evidence.

The first maintained oracle covers:

- provider-independent graph validity; and
- effect ordering over already-normalized effect facts.

Provider-specific interpretation remains outside this Lean boundary. For
example, GitHub status-coordinate normalization remains ordinary TypeScript
adapter semantics. Lean receives the resulting normalized resource, desired
state, commutativity, obligation IDs, and dependency edges.

## Trust and authority boundary

The intended relationship is:

```text
normalized semantic facts
        |
        +--------------------+
        |                    |
        v                    v
Lean reference          production TypeScript
specification           optimized implementation
+ proofs                       |
        |                      |
        +----------+-----------+
                   |
                   v
          differential evidence
```

Lean is normative evidence about the meaning of selected predicates. It is not
part of the runtime authority chain that owns:

- durable facts;
- SQLite authority;
- execution fencing;
- provider observation;
- mutation reservation;
- recovery;
- settlement;
- scheduling;
- provider credentials.

The production runtime must not require a Lean process to be healthy in order to
replay authority history or operate normally.

## Why this is not “Lean as a second implementation”

A duplicated implementation is only useful here when one side has a different
epistemic role.

The TypeScript path answers:

> How should Overcenter compute this efficiently inside the production runtime?

The Lean path answers:

> What relation is intended, and what stronger property can be established about
> an accepted result?

CI then asks whether the optimized production implementation still computes the
same bounded relation.

The Lean executable must therefore consume facts, not caller-computed
conclusions such as `acyclic=true` or `effect_conflict_free=true`.

## Promotion rule

A Lean predicate may become the production implementation only after a separate
experiment shows that doing so makes the system smaller or stronger overall.

At minimum, such an experiment must show:

- an existing authority-bearing production implementation can be deleted rather
  than retained as a fallback or co-authority;
- exact historical replay remains safe and operationally acceptable;
- failure is fail-closed;
- binary/version identity is bound explicitly where it matters;
- the new runtime dependency does not require disproportionate lifecycle
  machinery;
- the resulting architecture is easier to explain than the implementation it
  replaces.

Passing oracle CI is not evidence that runtime promotion is desirable.

## CI policy

The semantic-oracle workflow pins an exact Lean reference revision and runs only
when files relevant to the checked predicates change, or when explicitly
dispatched.

The first oracle checks:

- all directed dependency graphs on four labeled nodes, comparing current
  TypeScript graph validity with Lean graph validity;
- unknown-dependency hostile cases;
- all 1,024 DAGs compatible with a five-node topological labeling, every
  target/competitor effect pair, three normalized effect scenarios
  (conflicting same resource, commuting same desired state, and distinct
  resources), and both obligation-list directions, comparing current TypeScript
  static-effect ordering with the Lean reference.

A green oracle check establishes bounded semantic agreement. It does not prove
the production implementation correct for every possible input, and it does not
upgrade provider-specific normalization into a Lean-proved claim.

## Consequences

### Positive

- Lean research has a durable job without becoming production plumbing.
- Production code can be optimized aggressively while semantic drift is made
  visible.
- Formal claims and ordinary tests remain distinct evidence classes.
- No Lean daemon, subprocess lifecycle, or runtime availability branch is added
  to the control plane.
- The same semantic reference can challenge future TypeScript, Go, Rust, or
  other implementations.

### Cost

- The repository must maintain a pinned oracle revision and explain intentional
  semantic changes.
- Oracle CI is slower than normal unit tests because it installs and builds Lean.
- Bounded exhaustive agreement is not the same thing as a universal proof of
  implementation equivalence.
- Provider-specific semantics still need their own evidence.

## Evidence

This decision is based on the Lean runtime/proof work and the current-main
authority-deletion experiment:

- PR #113: proved and benchmarked indexed Lean claim admission;
- PR #115: tested whether current-main TypeScript graph authority should be
  replaced by a Lean runtime boundary.

The important conclusion from those experiments is not “never run Lean in
production.” It is narrower:

> Lean has earned a semantic-reference role. Runtime promotion requires separate
> evidence that the integration itself improves the architecture.
