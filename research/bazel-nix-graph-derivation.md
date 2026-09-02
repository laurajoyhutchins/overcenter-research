# Bazel and Nix Graph Derivation as Prior Art for Overcenter

**Date:** 2026-09-02  
**Status:** Research note  
**Scope:** Bazel and Nix as prior art for Overcenter's project graph, with emphasis on immutable inputs, content-addressed identity, dependency graphs, hermetic actions, cache validity, incremental recomputation, derivations, and mechanically determining whether work is already satisfied.

## Executive conclusion

The strongest lesson from Bazel and Nix is not that Overcenter should become a build system. It is that Overcenter can adopt the part of build systems that answers a more fundamental question:

> **Given exact inputs and exact acceptance rules, is this obligation already satisfied?**

A conventional task-oriented project graph tends to represent a node as mutable work state:

```text
READY -> RUNNING -> DONE
```

That representation makes execution history central. It encourages the system to remember that a worker once completed a task and then trust or reconcile the resulting status later.

Bazel and Nix suggest a stronger model:

```text
exact inputs
    |
    v
immutable obligation
    |
    +--> acceptable verified realization already exists --> SATISFIED
    |
    +--> no acceptable realization --> execute producer
                                      |
                                      v
                                  realization
                                      |
                                   verify
                                      |
                                      v
                                   SATISFIED
```

For Overcenter, the key architectural move is:

> **A project node should evolve from a mutable task record into an immutable obligation predicate over exact inputs, required outputs, and verification evidence.**

Execution becomes one possible way to obtain a realization of that obligation. A successful prior agent session, another concurrent session, a human commit, an existing artifact, or an already-realized external state can all satisfy the same obligation if the evidence proves they satisfy the exact current predicate.

This is where Bazel and Nix are unusually useful prior art for agentic project orchestration.

They also reveal a boundary Overcenter must preserve. Build systems work best when actions are pure or close to pure. Overcenter frequently manages nondeterministic reasoning and consequential mutations across GitHub, CI, hosting, and other systems. Those operations cannot be treated as ordinary cache hits. They still require leases, fencing, exact authority, receipts, settlement, ambiguity handling, and authoritative readback.

The synthesis should therefore be:

```text
                 PROJECT INTENT
          immutable graph obligations
                        |
                        v
               DERIVATION ENGINE
      exact inputs + satisfaction + frontier
                        |
             +----------+----------+
             |                     |
       proof/reuse hit          needs work
             |                     |
             |                     v
             |             EXECUTION KERNEL
             |          lease / agent / retry
             |          fence / settlement
             |          receipt / recovery
             |                     |
             +----------+----------+
                        v
                   REALIZATIONS
                outputs + evidence
                        |
                        v
                   VERIFICATION
                        |
                        v
                  PROJECT TRUTH
```

Bazel is strongest prior art for explicit dependency graphs, action identity, hermeticity, cache correctness, and incremental recomputation.

Nix is strongest prior art for immutable derivations, store identity, realization, dependency closure, and the distinction between an instruction for producing something and the concrete thing that was produced.

Overcenter's distinctive contribution should be to extend those ideas to nondeterministic reasoning, predicate-valued obligations, evidence-backed verification, and transactional external effects.

---

## 1. Why build-system prior art matters to Overcenter

Overcenter's project graph has two jobs that are easy to conflate:

1. represent what the project requires;
2. coordinate attempts to make those requirements true.

A mutable task record mixes these concerns. For example:

```text
node:
  id: lease-fencing
  status: done
  depends_on:
    - lease-model
```

The record says that work happened, but it does not mechanically answer:

- Which exact repository revision was the work based on?
- Which exact dependency outputs were consumed?
- Which policy or verifier version established correctness?
- What concrete result was produced?
- Is the result still valid after an upstream change?
- Could a different result satisfy the same requirement?
- If another worker independently satisfied the requirement, can this work be skipped?
- If verification policy changes, can the existing result be reverified without rerunning the reasoning agent?

Build systems exist largely to answer analogous questions mechanically.

They do so by moving identity and dependency structure out of human memory and into deterministic software.

That matches Overcenter's core design pressure: reasoning agents should make judgments; deterministic software should own execution correctness and mechanically knowable bookkeeping.

---

## 2. Bazel: actions are defined by declared inputs

Bazel models builds as a dependency graph of configured targets and actions. Actions have declared inputs, declared outputs, command lines, environment, and execution requirements. A build result can be reused when Bazel can establish that the effective action identity has not changed and an acceptable result already exists.

This is materially different from remembering that a build step previously reported success.

The relevant idea is:

```text
result validity
    !=
"this command succeeded once"

result validity
    =
"this result corresponds to this exact action identity"
```

For Overcenter, the analogous identity should not be an agent run ID. It should describe the exact obligation the run was trying to satisfy.

### Mapping

| Bazel concept | Overcenter analogue |
|---|---|
| Declared action inputs | Exact Git revision, dependency outputs, policies, external observation snapshots |
| Action key | Immutable obligation/evaluation key |
| Action execution | One bounded attempt to produce a realization |
| Action result | Realization produced by an agent, tool, human, or deterministic worker |
| Output artifact | Patch, Git tree, commit, report, generated file, provider object, receipt |
| Action cache | Mapping from exact obligation key to candidate realizations |
| Content-addressed store | Immutable artifact/evidence store keyed by digest |
| Target graph | Project obligation graph |
| Rebuild | Re-evaluate only obligations whose relevant inputs changed |

The lesson is not necessarily to copy Bazel's action key format. The lesson is to insist that reuse be based on complete declared identity rather than mutable lifecycle history.

### Source

- Bazel, **Remote caching**: https://bazel.build/remote/caching
- Bazel, **Build concepts**: https://bazel.build/concepts/build-ref

---

## 3. Bazel hermeticity: undeclared reads break incremental correctness

Bazel's strongest correctness property comes from hermeticity. A hermetic action should depend only on its declared inputs, selected tools, and explicit environment rather than arbitrary ambient machine state.

This is what makes action caching meaningful.

If an action secretly depends on `/usr/bin/foo`, the current time, an undeclared network response, or another file outside the dependency graph, then the action key does not fully describe what determined the result. A cache hit may be stale even though the action key appears unchanged.

For Overcenter, the corresponding rule should be explicit:

> **Every external fact that can change whether a node's realization is acceptable must be represented as an exact declared input, an immutable observation snapshot, or an explicitly non-cacheable authority/freshness check.**

Examples of potentially hidden dependencies in agent work include:

- current pull-request head;
- branch protection state;
- CI check status;
- tool or CLI behavior;
- package versions;
- repository policy files;
- current production deployment;
- external issue state;
- current date or deadline;
- remote API responses;
- unstated agent environment assumptions.

This does not imply that every Overcenter operation must be perfectly hermetic. Many cannot be.

It means impurity must be modeled rather than ignored.

A useful distinction is:

```text
hermetic obligation
    exact inputs completely determine acceptability

observational obligation
    mutable reality is first captured as an immutable snapshot

transactional obligation
    acceptance depends on a current external authority state and durable effect evidence
```

The graph engine should know which class it is evaluating.

### Source

- Bazel, **Hermeticity**: https://bazel.build/basics/hermeticity

---

## 4. Bazel Skyframe: the graph is an incremental evaluator

Bazel's Skyframe evaluation model is particularly relevant to Overcenter.

Skyframe represents computation as keys and immutable values. An evaluator computes a value by requesting other keys as dependencies. Those dependency relationships are recorded. When an input changes, Bazel can invalidate the affected reverse transitive closure rather than recomputing the entire world.

The important conceptual shift is that the graph is not merely a scheduling DAG. It is a **dataflow and validity graph**.

For Overcenter, this suggests that project edges should eventually answer more than:

> Must A happen before B?

They should answer:

> Which exact fact produced by A participates in whether B is satisfied?

That is a much stronger representation.

### Example

A coarse task graph might say:

```text
compile -> test
```

The semantic relationship is actually closer to:

```text
compile
   |
   +--> output artifact digest abc123
                   |
                   v
                 test
```

`test` depends on the exact artifact produced by `compile`, not merely on the historical fact that a compile task once completed.

Likewise:

```text
security-review -> publish
```

may mean:

```text
candidate revision abc123
        |
        v
security approval bound to abc123
        |
        v
publication predicate
```

That is an evidence/authority dependency, not a generic ordering edge.

### Source

- Bazel, **Skyframe**: https://bazel.build/reference/skyframe

---

## 5. Dependency edges should carry semantics

Overcenter should distinguish at least three dependency classes.

### 5.1 Value dependency

B consumes an output produced or selected by A.

```text
A -- exact output identity --> B
```

If the consumed output identity changes, B's obligation identity may change.

Examples:

- generated schema consumed by implementation;
- exact Git tree consumed by tests;
- compiled artifact consumed by deployment verification.

### 5.2 Control dependency

A must precede B for scheduling, policy, or process reasons, but A's concrete output is not semantically an input to B.

```text
A -- ordering constraint --> B
```

This may affect executability without necessarily affecting B's semantic obligation identity.

### 5.3 Evidence or authority dependency

B requires a proof, approval, receipt, or authority fact associated with A.

```text
A -- exact evidence identity --> B
```

Examples:

- production promotion requires approval bound to an exact release candidate;
- merge requires CI evidence bound to an exact head;
- downstream work requires a settlement receipt proving an upstream external effect occurred.

Treating all three as `depends_on` throws away information needed for correct invalidation and reuse.

### Recommendation

The project graph should gradually evolve from an ordering DAG toward a typed dependency graph in which edges describe what downstream validity actually consumes.

---

## 6. Nix: a derivation is not the same thing as its realized output

Nix provides a complementary abstraction.

A derivation describes how to produce one or more outputs from specified inputs. Realising the derivation means making the desired output path valid, whether by building it locally, obtaining it from another builder, or substituting an already-existing result.

This distinction is directly useful to Overcenter:

```text
obligation / derivation
      !=
execution attempt
      !=
realized result
```

A node should not mean "the worker session that performed this task."

It should mean "the exact project obligation to be satisfied."

A particular agent run is merely one producer of one possible realization.

This gives Overcenter a cleaner way to reason about concurrent work:

```text
same obligation
   |
   +--> agent session A -> realization A
   |
   +--> agent session B -> realization B
   |
   +--> human commit    -> realization C
```

Any realization may satisfy the obligation if current verification accepts it.

The graph does not need to pretend that only one historically blessed worker can make the node true.

### Source

- Nix Reference Manual, **Glossary / derivation / realisation**: https://nix.dev/manual/nix/latest/glossary

---

## 7. Nix identity: input-addressed and content-addressed are different ideas

A crucial Nix nuance is that output identity has historically often been input-addressed, not simply a hash of output bytes.

An input-addressed derivation identifies outputs through the derivation and its declared production recipe. Two byte-identical outputs produced by different derivations need not automatically share an identity.

Content-addressed derivations and content-addressed store objects provide a different mode in which resulting content itself participates directly in identity.

This distinction is valuable for Overcenter because a project obligation and a concrete produced artifact are not the same identity.

Overcenter should preserve at least three layers:

```text
OBLIGATION IDENTITY
"What exact thing are we trying to prove?"

REALIZATION IDENTITY
"What exact result was produced?"

EVIDENCE / VERIFICATION IDENTITY
"What exact proof establishes that this realization satisfies this obligation?"
```

Trying to compress all three into a mutable node ID would lose the most useful part of the Nix model.

### Sources

- Nix Reference Manual, **Input-addressed output**: https://nix.dev/manual/nix/latest/store/derivation/outputs/input-address.html
- Nix Reference Manual, **Store objects**: https://nix.dev/manual/nix/latest/store/store-object

---

## 8. Overcenter nodes should be predicate-valued, not action-valued

This is the most important adaptation.

A build action often has a narrowly specified output contract. Agentic software work is more open-ended.

Consider the obligation:

> Fix stale-lease commit handling while preserving exact Git revision fencing and passing the required verification suite.

There may be many valid patches.

Therefore the correct model is not:

```text
exact inputs
    |
    v
deterministic command
    |
    v
one predetermined output
```

It is:

```text
exact inputs
    |
    v
obligation predicate
    |
    +--> realization A -> verify -> PASS
    |
    +--> realization B -> verify -> PASS
    |
    +--> realization C -> verify -> FAIL
```

The producer can be nondeterministic while satisfaction remains mechanically decidable at the boundary.

That is a better fit for reasoning agents.

### Architectural rule

> **The node describes what must be true. The producer chooses how to make it true. Verification decides whether the produced realization qualifies.**

This separates judgment from execution correctness cleanly.

---

## 9. Candidate immutable obligation model

A future internal node model could resemble:

```text
ObligationSpec {
    logical_node_id

    inputs:
        exact immutable identities
        references to dependency outputs
        exact observation snapshots where required

    required_outputs:
        named output contracts
        schemas / predicates

    verification:
        verifier specification
        evidence requirements
        acceptance policy

    producers:
        zero or more ways to obtain a realization

    effect_class:
        pure
        observation
        external_mutation
        human_authority
}
```

This should be canonicalized before hashing.

A useful split is:

```text
spec_digest = H(canonical ObligationSpec)
```

Then resolve symbolic inputs to their exact identities:

```text
obligation_key = H(
    spec_digest,
    resolved exact input identities,
    relevant toolchain identities,
    relevant policy identities
)
```

The exact formula is an implementation detail. The contract matters more:

- semantically relevant changes must change the key;
- semantically irrelevant execution bookkeeping must not change the key;
- canonicalization must be deterministic;
- identity rules must be versioned explicitly.

### Do not hash volatile execution state

The following should generally not participate in obligation identity:

- lease IDs;
- run IDs;
- worker IDs;
- heartbeat timestamps;
- retry counts;
- display status;
- attempt-local logs;
- scheduler choice;
- transient provider request IDs unless semantically required.

If these enter the obligation key, every attempt creates a new obligation and reuse becomes impossible.

---

## 10. Realizations should be immutable first-class objects

A producer yields a realization:

```text
Realization {
    obligation_key
    output_manifest
    artifact_digests
    effect_receipts
    producer_metadata
}
```

The realization itself gets an immutable identity:

```text
realization_digest = H(canonical Realization)
```

The output manifest can name artifacts such as:

- Git tree or commit;
- patch;
- generated files;
- structured analysis;
- compiled artifact;
- test result bundle;
- deployment candidate;
- provider-side immutable object;
- receipt describing a transactional effect.

This means "the work" does not disappear when the lifecycle advances.

The realization remains a durable fact that can later be:

- reverified;
- compared with another realization;
- reused by downstream obligations;
- rejected by a newer verifier;
- retained as historical evidence for an older obligation key.

---

## 11. Verification should have its own identity

Do not permanently fuse a realization with the verifier that first accepted it.

A useful identity is:

```text
verification_key = H(
    realization_digest,
    verifier_digest,
    verification_policy_digest
)
```

This buys Overcenter an important capability:

> **Changing the verifier does not automatically require repeating expensive reasoning work.**

Suppose an agent produced a patch yesterday. Today the project strengthens its verification policy.

Overcenter can keep the immutable realization and run the newer verifier against it.

If it still passes, no agent rerun is needed.

If it fails, the current obligation is unsatisfied and a producer can be invoked again.

This is particularly valuable when reasoning execution is expensive while deterministic verification is cheap.

---

## 12. Satisfaction becomes a deterministic predicate

The central graph function should be something conceptually like:

```text
SATISFIED(N) iff

    exists realization R and verification V such that:

        R.obligation_key = current_obligation_key(N)

    and required_outputs(N) accept outputs(R)

    and V.realization_digest = digest(R)

    and V.verifier_digest = current_verifier_digest(N)

    and V.result = PASS

    and required evidence exists and remains valid

    and relevant authority / freshness constraints hold
```

This is stronger than storing:

```text
node.status = DONE
```

The old status bit is an assertion. The satisfaction predicate is a reproducible derivation from exact project facts.

### Consequence

A realization can remain historically valid while no longer satisfying the current obligation.

Example:

```text
old obligation key: abc123
realization R1: PASS

upstream exact input changes

new obligation key: def456
R1 remains valid evidence for abc123
R1 does not prove def456
```

No process needs to mutate `R1` from "done" back to "not done."

The current project projection simply derives that the current obligation lacks a valid realization.

This is one of the cleanest ideas Nix contributes to Overcenter.

---

## 13. Stable logical names over immutable node revisions

Humans still need stable project concepts such as:

```text
lease-fencing
project-amend-recovery
typescript-migration
```

These should remain logical node IDs.

Behind each logical ID, however, the specification should be immutable and versioned by content:

```text
lease-fencing
     |
     +--> spec a13f...   old obligation revision
     |        |
     |        +--> realization 88bc... PASS
     |
     +--> spec e91d...   current obligation revision
              |
              +--> no acceptable realization yet
```

A project graph revision can therefore become conceptually:

```text
ProjectGraphRevision {
    project_policy_digest
    bindings:
        logical_node_id -> spec_digest
}
```

and then:

```text
graph_revision = H(canonical ProjectGraphRevision)
```

Changing one logical node creates a new graph root while all unchanged immutable substructure can be reused.

This is similar in spirit to persistent immutable data structures and content-addressed build graphs.

---

## 14. "DONE" should become a projection of satisfaction

If satisfaction is derivable, project-facing lifecycle states can become projections rather than independently authoritative records.

A simplified derivation is:

```text
resolve current obligation key
        |
        +--> acceptable verified realization exists
        |            |
        |            +--> SATISFIED
        |
        +--> no acceptable realization
                     |
               prerequisites satisfied?
                 |             |
                no            yes
                 |             |
              WAITING        READY
```

Then execution state overlays the derived graph state:

```text
READY + active valid execution lease -> EXECUTING
READY + explicit policy barrier      -> BLOCKED
```

This suggests two semantic cleanups.

### 14.1 DONE is not primary truth

`DONE` should usually be a display projection of `SATISFIED`, not a mutable fact whose provenance must be trusted forever.

### 14.2 FAILED belongs mainly to attempts

A failed worker does not mean the project obligation itself has failed permanently.

It means one attempted realization failed.

The obligation may remain READY, become BLOCKED due to a discovered condition, or later be satisfied by another producer.

This reduces accidental coupling between agent reliability and project truth.

---

## 15. Incremental recomputation follows actual invalidation

Once obligation identity and typed dependencies are explicit, graph recomputation becomes much more mechanical.

Suppose:

```text
A1 -> B7 -> C4 -> D2
        |
        +----> E9
```

If A changes, only the reverse dependency closure needs reconsideration.

After recomputing B, suppose B's relevant realized output remains byte-for-byte or semantically identical:

```text
A2 -> B7 -> C4 -> D2
        |
        +----> E9
```

Then C, D, and E may remain valid without reopening them.

This is an important Bazel/Skyframe lesson: invalidation need not propagate farther than actual value changes require.

For Overcenter, this means a graph amendment should not cause broad lifecycle churn merely because an upstream logical node changed.

Instead:

1. the changed specification gets a new immutable identity;
2. affected obligation keys are recomputed;
3. current realizations are checked against those exact new keys;
4. invalidation propagates only through dependency edges whose consumed values or proofs actually changed;
5. the frontier is derived again.

This can make large project graphs substantially cheaper and less noisy.

---

## 16. Dynamic dependency discovery can coexist with immutable obligations

Agentic work cannot always declare its entire dependency closure before reasoning begins.

That does not invalidate this architecture.

Skyframe itself supports computations that request dependencies while evaluating. The critical point is that the dependency graph is recorded before the resulting value is treated as safely reusable.

Overcenter can use the same principle:

```text
provisional obligation
        |
        v
reasoning / dependency discovery
        |
        v
complete relevant input closure
        |
        v
freeze exact obligation identity
        |
        v
produce / reuse / verify realization
```

The rule should be:

> **Dependency discovery may be dynamic. Reuse may not depend on invisible dynamic state.**

If an agent discovers a new material prerequisite, that prerequisite must become graph-visible before the realization can be considered generally reusable.

This is especially relevant to dynamic graph amendment and delegated subwork.

---

## 17. Cache validity should be understood as proof validity

Calling this merely a cache risks importing the wrong mental model.

For ordinary build systems, cache validity often means:

```text
this action result corresponds to this action key
```

For Overcenter, the stronger statement is:

```text
this realization still constitutes acceptable proof
of this exact current project obligation
```

A reusable result therefore depends on more than artifact availability.

It may require:

- exact obligation identity match;
- required artifacts still available;
- exact evidence retained;
- current verifier acceptance;
- policy compatibility;
- exact Git authority binding;
- provider receipt validity;
- freshness constraints for observations;
- absence of an invalidating external transition.

This suggests two separate internal indexes:

```text
obligation_key
    |
    +--> candidate realization(s)

realization_digest + verifier/policy digest
    |
    +--> verification result + evidence
```

Multiple candidate realizations for one obligation should be normal.

Agent production is nondeterministic. Overcenter should not pretend otherwise.

---

## 18. Effect classes define how much reuse is safe

The build-system model applies differently depending on what the node does.

Overcenter should explicitly classify obligations by effect semantics.

| Effect class | Example | Reuse semantics |
|---|---|---|
| Pure derivation | Generate source, compute analysis, transform data | Strong content/input-addressed reuse |
| Observation | Read current branch protection or deployment state | Reuse immutable snapshot subject to freshness policy |
| External mutation | Create release, merge PR, change branch policy | Require exact intent, fencing, receipt, readback, ambiguity handling |
| Human authority | Approve release or policy exception | Bind approval to exact obligation/realization identity |

This classification is central. Without it, a generic "cache hit" abstraction would be unsafe.

---

## 19. Observations should become immutable snapshots

Mutable external reality can often be brought into the derivation model by capturing a bounded observation.

Example:

```text
GitHub branch state
      |
    observe
      |
      v
Snapshot {
    repository
    exact provider coordinates
    canonical observed state
    observed_at
    observation method/version
    digest
}
```

Downstream obligations consume the immutable snapshot identity.

If the project requires "current within ten minutes," freshness should be expressed as policy over the snapshot rather than hidden inside its content identity.

This distinction matters:

- content identity says what was observed;
- freshness policy says whether that observation is still acceptable now.

That permits deterministic reasoning about both provenance and staleness.

---

## 20. External mutations must not become ordinary cache hits

This is where Overcenter must deliberately remain stronger than Bazel or Nix.

Consider a node whose producer creates a GitHub Release.

It would be unsafe to say:

```text
same obligation key -> previous execution succeeded -> skip mutation
```

The correct statement is closer to:

```text
same exact mutation intent
    + durable receipt
    + authoritative current readback
    + no conflicting external state
    = effect already realized
```

A mutation's reusable proof must be about authoritative external state, not merely about a prior worker's return value.

Therefore Overcenter still needs:

- exact revision checks;
- lease/fencing authority;
- idempotency identity;
- mutation certainty classification;
- durable receipts;
- authoritative readback;
- settlement;
- recovery for ambiguous outcomes.

The derivation engine can ask whether the mutation obligation is already satisfied, but the evidence required to answer yes is fundamentally transactional.

This is the boundary where Overcenter adds something build systems generally do not provide.

---

## 21. Concurrency becomes much cleaner

Suppose Session A begins working on obligation key `8a17...`.

Session B independently produces a different patch and verifies it against the same exact obligation.

```text
Session B
   |
   v
realization B
   |
verification PASS
   |
   v
obligation 8a17... SATISFIED
```

Session A does not need to be conceptually "robbed" of a task.

When A later returns, Overcenter can mechanically classify the result:

- if it realizes the same current obligation, it is another candidate realization;
- if upstream inputs changed, it realizes an older obligation key and cannot settle the new one;
- if it is redundant, the project can retain or discard it according to artifact policy;
- if it provides a better realization, policy may choose it without rewriting history.

This is a more principled concurrency model than treating task ownership and task truth as the same thing.

Leases still protect bounded execution and mutation authority. They no longer have to carry the burden of defining whether an obligation is semantically satisfied.

---

## 22. Frontier computation becomes almost purely mechanical

With immutable obligations, exact dependency inputs, and a satisfaction evaluator, the graph frontier can be derived in a deterministic pass.

For each logical node:

```text
resolve current spec
        |
resolve exact input identities
        |
compute obligation key
        |
        +--> valid verified realization exists
        |          |
        |          +--> SATISFIED
        |
        +--> no valid realization
                   |
             prerequisites satisfied?
                |           |
               no          yes
                |           |
             WAITING       READY
```

Execution overlays can then add:

```text
READY + valid lease           -> EXECUTING
READY + unresolved ambiguity  -> BLOCKED / RECOVERY
READY + human policy gate     -> BLOCKED
```

This is exactly the sort of deterministic project bookkeeping that should not be delegated to a reasoning agent.

---

## 23. Implications for Overcenter's semantic surface

This architectural change should mostly remain behind the existing intent-first commands.

It should not produce a large conceptual API such as:

```text
node.hash
node.cache.lookup
node.invalidate
realization.attach
verification.lookup
graph.recompute
```

Those are internal mechanisms.

The user-facing or agent-facing experience should remain centered on project intent and bounded judgment:

```text
project.inspect
project.advance
project.define
project.amend
```

Conceptually, `project.advance` can become:

```text
derive current obligation keys
        |
        v
derive satisfaction
        |
        +--> already satisfied -----------+
        |                                 |
        +--> unsatisfied                  |
               |                          |
          dependencies satisfied?         |
               |                          |
               v                          |
       expose executable frontier         |
               |                          |
               v                          |
       acquire bounded execution          |
               |                          |
               v                          |
         produce realization              |
               |                          |
               v                          |
        settle / verify proof             |
               |                          |
               +--------------------------+
                          |
                          v
                 recompute frontier
```

The reasoning agent sees the judgment boundary. Overcenter owns identity, reuse, invalidation, verification binding, and project-state derivation.

---

## 24. A concrete example

Consider a project obligation:

> Ensure `project.amend` can recover safely from an interrupted or ambiguous repository write while preserving exact-revision fencing.

A mutable task representation might be:

```yaml
id: fix-project-amend
status: READY
depends_on:
  - mutation-journal
```

A derivation-oriented representation is richer:

```yaml
logical_id: project-amend-ambiguous-write-recovery

inputs:
  repository_base:
    git_commit: 9af0...

  mutation_contract:
    digest: 12c4...

  recovery_contract:
    digest: b038...

  mutation_journal_output:
    realization: d391...

required_outputs:
  source_change:
    predicate: modifies project.amend recovery behavior

verification:
  required:
    - ambiguous-write fixture passes
    - exact-revision drift fails closed
    - replay converges
    - mutation is never blindly retried

producer:
  kind: reasoning_agent_software_change

effect_class: pure
```

Canonical resolution yields:

```text
obligation_key = sha256:8a17...
```

Session A starts work.

Meanwhile Session B independently produces a different patch whose realization verifies against `8a17...`.

The node is now satisfied.

Session A's later result is handled based on identity and evidence, not narrative history.

If it also realizes `8a17...`, it is another candidate.

If an input changed and the current obligation is now `91bc...`, Session A's old result cannot silently satisfy the new obligation.

No mutable status arbitration is needed to establish project truth.

---

## 25. What Bazel and Nix should not convince Overcenter to do

Several tempting interpretations would be mistakes.

### 25.1 Do not require deterministic agent output

Agents need not produce byte-identical patches for the same obligation.

The predicate and verifier provide determinism at the acceptance boundary.

### 25.2 Do not content-address leases or runtime bookkeeping

Execution metadata is not semantic project identity.

### 25.3 Do not treat every external operation as cacheable

Provider mutations require transactional evidence and current readback.

### 25.4 Do not force all dependencies to be known before reasoning begins

Allow dynamic discovery, but freeze the complete relevant closure before general reuse.

### 25.5 Do not let content hashes replace semantic versioning or policy identity

Hash equality proves identity under a particular canonicalization contract. It does not explain compatibility or semantic meaning to humans.

### 25.6 Do not turn Overcenter into an artifact store product

A content-addressed store may be useful infrastructure, but the product boundary remains verified project transitions.

---

## 26. Recommended architecture changes

### 26.1 Introduce immutable obligation revisions

Keep stable logical node IDs, but make each node specification immutable and canonically digestible.

### 26.2 Make exact inputs first-class

Replace ambiguous dependency relationships with explicit consumption of exact upstream outputs, evidence, authority, or ordering constraints wherever possible.

### 26.3 Introduce first-class realizations

A completed execution should produce an immutable realization manifest rather than merely a status transition.

### 26.4 Separate verification records from realizations

Allow the same realization to be evaluated under newer verifier and policy identities.

### 26.5 Implement one authoritative satisfaction evaluator

`project.inspect`, frontier computation, and `project.advance` should all rely on the same deterministic definition of whether an obligation is currently satisfied.

### 26.6 Add typed dependency edges

At minimum distinguish value, control, and evidence/authority dependencies.

### 26.7 Classify obligations by effect semantics

Use explicit `pure`, `observation`, `external_mutation`, and `human_authority` classes or an equivalent model.

### 26.8 Derive presentation state from immutable facts

Gradually demote mutable `DONE`, `WAITING`, and `READY` fields from source-of-truth status into derived project views.

### 26.9 Keep transactional execution semantics intact

Leases, fencing, settlement, receipts, ambiguity handling, and recovery remain necessary for producing new realizations safely.

### 26.10 Add incremental invalidation

Track reverse dependencies so graph amendments and changed observations only re-evaluate the portions of the graph whose semantic inputs may have changed.

---

## 27. Suggested internal model

A minimal conceptual model could be:

```text
LogicalNode
    id
    current_spec_digest

ObligationSpec
    spec_digest
    canonical_definition
    dependency_declarations
    verifier_spec
    effect_class

ResolvedObligation
    obligation_key
    spec_digest
    resolved_input_manifest
    graph_revision

Realization
    realization_digest
    obligation_key
    output_manifest
    artifact_refs
    effect_receipts

Verification
    verification_key
    realization_digest
    verifier_digest
    policy_digest
    result
    evidence_refs

Attempt
    attempt_id
    obligation_key
    lease / fence
    producer
    runtime state
    settlement
```

The most important separation is:

```text
project semantics:
    LogicalNode
    ObligationSpec
    ResolvedObligation
    Realization
    Verification

execution mechanics:
    Attempt
    lease
    retries
    heartbeat
    settlement
    recovery
```

Execution mechanics can change rapidly without invalidating the semantic identity of the project obligation.

---

## 28. Migration path

This can be introduced without a flag-day rewrite.

### Phase 1: identity only

Add canonical digests for existing node definitions and exact resolved inputs while preserving current lifecycle storage.

Use the digests diagnostically first.

### Phase 2: realization manifests

On successful settlement, emit an immutable realization record that names the exact obligation key, outputs, and evidence.

Continue writing existing lifecycle state for compatibility.

### Phase 3: satisfaction evaluator

Implement deterministic `satisfied(node)` from obligation key + realization + verification evidence.

Compare the derived answer with existing `DONE` state and report mismatches.

Do not immediately change scheduling behavior.

### Phase 4: derived frontier

Make READY / WAITING / SATISFIED frontier computation use the satisfaction evaluator.

Keep leases and attempt state as overlays.

### Phase 5: typed invalidation

Use exact dependency identities to incrementally recompute only dirty graph regions.

### Phase 6: status demotion

Remove mutable lifecycle fields that merely duplicate deterministically derivable state.

This migration ordering preserves evidence and gives Overcenter opportunities to prove equivalence before deleting old bookkeeping.

---

## 29. Mechanical properties Overcenter could eventually guarantee

If this model is implemented carefully, Overcenter could make strong claims such as:

1. **No stale completion:** a realization for an old obligation key cannot satisfy a newer exact-input obligation.
2. **No duplicate reasoning when unnecessary:** if acceptable verified evidence already realizes the current obligation, a new agent execution is unnecessary.
3. **Verifier evolution without mandatory re-execution:** existing realizations can be rechecked under newer verification policy.
4. **Precise invalidation:** changing an input dirties only nodes that semantically consume that input or affected downstream values/evidence.
5. **Concurrency without task theft:** multiple attempts can produce candidate realizations while project truth is determined independently by satisfaction.
6. **Historical monotonicity:** old realizations remain immutable historical facts even when current project requirements move on.
7. **Evidence-backed DONE:** project completion is derivable from exact current obligation keys and valid proof rather than trusted mutable flags.
8. **Impurity is explicit:** mutable observations and external effects cannot silently masquerade as hermetic cached computation.

These are meaningful correctness properties for autonomous software work.

---

## 30. Open design questions

Several details deserve separate design work before implementation.

### Canonicalization

What exact serialization and schema-version contract defines `spec_digest`, `obligation_key`, realization identity, and verifier identity?

### Semantic output equivalence

When can two different outputs be considered equivalent for downstream invalidation purposes?

Byte identity is sufficient for some artifacts but unnecessarily strict for others.

### Observation freshness

How should freshness policies compose with immutable observation snapshots without injecting wall-clock state into core identity?

### Verifier authority

Which verifier versions are acceptable for which project graph revisions, and how is verifier trust itself represented?

### Garbage collection

How long should old realizations, verification results, and superseded obligation revisions remain retained?

Historical evidence and recovery requirements may impose stronger retention than an ordinary build cache.

### Secret inputs

How can a secret participate in identity or invalidation without recording secret bytes in project metadata?

### External provider identity

What exact provider coordinates are stable enough to act as immutable observation or effect identities?

### Human judgment outputs

When an obligation truly requires subjective review rather than mechanical verification, how should the resulting approval be bound to exact candidate identity and policy scope?

These questions do not weaken the model. They identify where build-system purity meets real project authority.

---

## 31. Bottom line

Bazel's durable lesson is:

> **Record every material dependency so validity and recomputation can be mechanical.**

Nix's durable lesson is:

> **Separate immutable production intent from concrete realizations, and give both stable identities.**

The Overcenter adaptation should be:

> **Model each project node as an immutable obligation predicate over exact inputs, required outputs, and verification evidence. Let nondeterministic producers create candidate realizations. Derive project truth from whether a valid realization currently proves the obligation satisfied.**

This changes the graph from a mutable work ledger into an incremental proof graph.

That is a particularly strong fit for Overcenter because it pushes mechanically knowable bookkeeping into deterministic software without pretending the reasoning work itself is deterministic.

The final architectural boundary should remain sharp:

```text
Bazel / Nix style derivation
    owns:
        immutable identity
        dependency closure
        reuse
        invalidation
        incremental recomputation
        satisfaction

Overcenter transactional kernel
    owns:
        bounded execution authority
        leases and fencing
        exact Git authority
        external mutation certainty
        settlement
        receipts
        recovery

Reasoning agents
    own:
        judgment
        design
        diagnosis
        choosing among valid implementations
```

The result is not "Nix for agents" or "Bazel for projects."

It is a system in which uncertain agent activity produces immutable candidate facts, deterministic software decides what those facts prove, and the project graph advances only from evidence that remains valid for the exact current obligation.

---

## Sources

### Bazel

- Bazel, **Build concepts**: https://bazel.build/concepts/build-ref
- Bazel, **Dependencies**: https://bazel.build/basics/dependencies
- Bazel, **Hermeticity**: https://bazel.build/basics/hermeticity
- Bazel, **Remote caching**: https://bazel.build/remote/caching
- Bazel, **Skyframe**: https://bazel.build/reference/skyframe
- Bazel Remote Execution API, **Remote Execution overview/specification**: https://github.com/bazelbuild/remote-apis

### Nix

- Nix Reference Manual, **Glossary**: https://nix.dev/manual/nix/latest/glossary
- Nix Reference Manual, **Store object**: https://nix.dev/manual/nix/latest/store/store-object
- Nix Reference Manual, **Input-addressed derivation output**: https://nix.dev/manual/nix/latest/store/derivation/outputs/input-address.html
- Nix Reference Manual, **Derivation store object**: https://nix.dev/manual/nix/latest/store/derivation/
- Nix Reference Manual, **Store paths**: https://nix.dev/manual/nix/latest/store/store-path
