# Petri Nets, Workflow Nets, and Workflow Correctness for Overcenter Graphs

## Executive summary

Petri-net and workflow-net theory is strong prior art for Overcenter because it separates two questions that are easy to conflate:

1. **Is a workflow definition structurally correct?**
2. **Is a live workflow instance still in a state that is compatible with a changed definition?**

For Overcenter, `project.define` should answer the first question before accepting a new graph. `project.amend` should answer both.

The main recommendation is **not** to turn Overcenter into a general Petri-net engine. The current dependency-DAG model is a highly analyzable subclass with implicit AND semantics: a node becomes executable only after all prerequisites are complete. That simplicity is valuable because many correctness properties that require state-space analysis in general workflow nets collapse to inexpensive graph proofs.

The highest-value addition is a **workflow correctness analyzer** that runs before project-authoring mutations. For a new graph it should prove structural soundness properties. For an amendment it should additionally prove that the current confirmed and in-flight execution state can be migrated to the candidate graph without creating an impossible history, invalidating active work, or destroying the possibility of completion.

A concise formulation is:

> `project.define` should prove that the proposed workflow is sound under Overcenter's graph semantics. `project.amend` should additionally prove that the current project marking is reachable and completion-preserving under the amended workflow.

The key dynamic-amendment concept to borrow from van der Aalst is the **change region**: determine which causal/synchronization region is affected by the amendment and reject or postpone ordinary migration while live execution occupies that region.

## 1. Relevant Petri-net concepts

A Petri net models concurrent state through **places**, **transitions**, and **tokens**. A transition fires when its input places contain the required tokens, consuming those tokens and producing tokens on its outputs. The marking, meaning the current distribution of tokens, is the workflow's execution state.

This is useful prior art for Overcenter because it gives precise language for several concerns that otherwise become informal graph intuitions:

- **Concurrency:** independent transitions may be enabled simultaneously.
- **Split:** one completed activity may enable multiple downstream activities.
- **Join:** one activity may require synchronization across several upstream activities.
- **Reachability:** whether a particular execution state can be produced from the initial state.
- **Liveness:** whether transitions retain the possibility of eventually firing.
- **Deadlock:** a nonterminal reachable state in which no productive transition can fire.
- **Safeness/boundedness:** whether tokens can accumulate unexpectedly.
- **Proper completion:** whether successful completion leaves no residual work behind.
- **Cancellation/reset:** semantics that remove or invalidate active state.
- **Dynamic change:** whether an in-flight workflow instance can safely migrate to a changed model.

### Workflow nets

Van der Aalst's workflow nets (WF-nets) specialize Petri nets for workflow processes. A WF-net has:

- one distinguished source place,
- one distinguished sink place,
- every place and transition on a path from source to sink.

The classical soundness criterion asks for three main properties:

1. **Option to complete:** from every reachable marking, it remains possible to reach proper completion.
2. **Proper completion:** when the final place is marked, no residual tokens remain elsewhere.
3. **No dead transitions:** every modeled transition can occur in some execution.

For ordinary WF-nets, soundness can be related to liveness and boundedness of the short-circuited net formed by connecting the sink back to the source.

These properties are stronger than simply proving that the graph contains some path from start to finish. A workflow may have a start-to-finish path while also admitting a different legal execution that deadlocks.

### Fairness versus structural progress

"Option to complete" means completion remains reachable. It does not by itself guarantee that an executor will eventually choose the completion-producing path when loops or choices exist. Fairness assumptions are needed to connect perpetual executability with eventual progress.

This distinction is important for general workflows, but much less troublesome for Overcenter's current acyclic dependency model because structural loops are forbidden.

## 2. Mapping the current Overcenter graph model to Petri-net semantics

The current Overcenter graph model is substantially simpler than a general Petri net:

- transitions have stable IDs;
- each transition has a `requires` set;
- all requirements must be complete before the transition becomes READY;
- completed transitions remain complete;
- prerequisite cycles are rejected;
- there is no explicit XOR/OR routing construct;
- there is no arbitrary token reset/cancellation primitive in the graph language.

Under this model, each prerequisite relationship can be interpreted as a causal place between two workflow transitions. Completion of an upstream transition satisfies all of its outgoing dependency facts. A downstream transition becomes enabled only when all incoming dependency facts are satisfied.

That gives the current graph these semantics:

- fan-out is an **AND-split**;
- fan-in is an **AND-join**;
- independent READY transitions are genuinely concurrent;
- each transition conceptually fires at most once;
- the completed set grows monotonically;
- cycles are forbidden.

This is close to an occurrence-net/partial-order model rather than a general workflow net with conflict and token competition.

That restriction is extremely useful. It means many workflow correctness questions can be answered with graph algorithms instead of general Petri-net reachability analysis.

## 3. Concurrency, splits, and joins

### Concurrency

If transitions `A` and `B` do not depend on each other and all of their prerequisites are satisfied, both can be READY simultaneously. The graph therefore already represents genuine partial-order concurrency.

No special concurrency construct is needed. Concurrency should continue to be derived from absence of causal dependency rather than encoded as explicit scheduler instructions.

### AND-splits

If transition `A` is a prerequisite of both `B` and `C`, completion of `A` may enable both branches. This is an AND-split: both downstream branches are legitimate work, not alternatives.

### AND-joins

If transition `D` requires both `B` and `C`, it becomes executable only when both are complete. This is a synchronizing AND-join.

### Do not infer XOR/OR semantics from topology

Workflow-pattern research makes clear that AND, XOR, and OR joins have materially different semantics. In particular, a synchronizing OR-join may need non-local knowledge: it must know not only which inputs have arrived but whether another branch can still become active.

That is a dangerous direction for Overcenter because it would make simple local readiness derivation depend on broader workflow-state reasoning.

Recommendation:

> Preserve bare `requires` as pure AND semantics. Never infer XOR or OR behavior from graph shape.

If alternatives are eventually needed, add them as explicit structured semantics rather than making the meaning of `requires` context-dependent.

Possible future constructs could distinguish concepts such as:

- `all_of`: every selected prerequisite must complete;
- `one_of`: exactly one explicitly selected branch satisfies the dependency;
- `all_selected`: all branches selected by a corresponding structured split must complete.

Unrestricted dynamic OR-joins should be avoided unless there is a compelling use case and an explicit correctness model.

## 4. Static correctness properties for `project.define`

`project.define` can mechanically prove substantially more than basic schema validity while remaining cheap for the current DAG semantics.

### 4.1 Referential integrity

Every dependency must reference an existing transition.

**Accept only if:** every `requires` ID is present in the definition.

### 4.2 Unique transition identity

Transition IDs and each transition's dependency list must be unique.

**Accept only if:** no duplicate transition IDs or duplicate prerequisite IDs exist.

### 4.3 No self-dependency

A transition cannot require itself.

### 4.4 Acyclicity

The prerequisite relation must be acyclic.

This can be proven with a topological sort or strongly connected components.

For the present semantics, acyclicity is not merely a convenient restriction. It collapses several harder workflow properties into straightforward induction over the partial order.

### 4.5 Start reachability and end reachability

Introduce synthetic `START` and `END` nodes conceptually:

- `START` connects to every transition with no prerequisites;
- every transition with no dependents connects to `END`.

Then prove that every transition lies on a path from synthetic `START` to synthetic `END`.

In a finite valid DAG this should normally follow from the structure, but making it an explicit property produces a useful correctness certificate and catches malformed future extensions.

### 4.6 Dead-transition freedom

A dead transition is one that can never execute in any legal run.

For the current finite acyclic all-of model, a transition is not dead if all of its ancestors can be completed. Because roots are initially structurally enabled and dependencies are monotone, topological induction can prove every node structurally executable.

This is far cheaper than general Petri-net dead-transition analysis.

### 4.7 Structural deadlock freedom

For the current DAG semantics, if the project is incomplete and all unfinished work is nominal, there should always exist at least one unfinished transition whose prerequisites are all complete.

Proof sketch:

1. Consider the subgraph induced by unfinished transitions.
2. Every finite DAG has at least one source.
3. A source in the unfinished subgraph has no unfinished prerequisite.
4. Therefore all of its prerequisites are complete.
5. Therefore it is structurally READY.

This gives Overcenter a strong and inexpensive deadlock-freedom theorem for nominal graph state.

### 4.8 Safeness

Because a transition completes at most once and dependency satisfaction is monotone, each causal dependency fact is produced at most once.

The graph therefore has an analogue of 1-safeness under the current model.

This should be documented as a derived invariant rather than introducing a token counter into the implementation.

### 4.9 Proper completion

Successful project completion should mean every required transition is terminal and there is no residual active workflow state.

The graph-level portion is straightforward: all transitions are DONE. Runtime state must additionally ensure there are no surviving leases/runs representing unfinished execution that contradicts that terminal graph state.

### 4.10 Option to complete

For a finite acyclic all-of graph, structural completion remains possible from every legal predecessor-closed completed set, assuming every nominal transition can eventually execute successfully.

This is the Overcenter-specific analogue of workflow-net option-to-complete.

It is important to state the assumption precisely: graph validation can prove control-flow possibility, not that GitHub, CI, humans, agents, networks, or hosting systems will cooperate.

### 4.11 Recommended static correctness certificate

`project.define` should internally derive a deterministic certificate such as:

```text
workflow_profile: overcenter-and-dag-v1
transition_count: 27
root_count: 4
sink_count: 3
acyclic: true
all_nodes_start_reachable: true
all_nodes_end_reachable: true
dead_transitions: []
join_semantics: all
safe: true
option_to_complete: true
```

The exact representation is less important than the principle: "valid graph" should be a set of mechanically derived facts, not merely a successful parser return.

The certificate can be hashed against the canonical graph revision and surfaced as verification evidence when useful.

## 5. Reachability as an Overcenter invariant

General Petri-net reachability asks whether a target marking can be produced from the initial marking. This is computationally difficult in the general case.

Overcenter's current graph language admits a much simpler characterization.

Let `D` be the set of completed transitions. For an execution state to be causally possible:

> `D` must be predecessor-closed.

That is, if transition `x` is complete, every prerequisite of `x` must also be complete.

Formally:

```text
x ∈ D  =>  requires*(x) ⊆ D
```

where `requires*` is the transitive prerequisite closure.

This is a specialized reachability test for the all-of DAG semantics.

It should be treated as a first-class invariant because it lets Overcenter reject impossible project histories without a general Petri-net solver.

The same principle applies to started/in-flight work: every transition that has entered execution must have had its prerequisites satisfied at the authoritative point where execution was enabled/acquired.

## 6. Runtime deadlock versus off-nominal blockage

Workflow theory helps distinguish two conditions that should not share one generic "nothing is ready" state.

For a structurally valid DAG, an incomplete project with no READY transitions should have an explanation in live/off-nominal execution state.

Conceptually:

```text
incomplete + no READY
        |
        +-- dependency chain reaches active/off-nominal work
        |       => execution/recovery blockage
        |
        +-- no such explanation
                => graph/state invariant violation
```

Every WAITING transition should be traceable through unmet prerequisites to either:

- a transition that is actively progressing, or
- an OFF_NOMINAL transition with a defined recovery path.

If the project is incomplete, has no READY work, and the causal closure contains neither active progress nor an explicit off-nominal blocker, Overcenter has reached an impossible or corrupted state and should fail closed.

This is the runtime counterpart to Petri-net deadlock detection.

## 7. Dynamic graph amendment is a migration problem

The most important prior art for `project.amend` is not static workflow soundness but van der Aalst's work on **dynamic workflow change**.

A sound old workflow and a sound new workflow do not imply that an in-flight instance can safely migrate between them.

A live instance may already have:

- completed activities;
- activities enabled under the old model;
- leased/acquired activities;
- work actively executing;
- effects being committed;
- confirmation in progress.

Changing the graph around that state can produce histories that were impossible under either model, skip work, duplicate work, or create deadlocks.

This is directly analogous to Overcenter graph amendment.

## 8. `project.amend` should validate state compatibility, not only candidate structure

For an amendment, define:

- `G` = authoritative old graph;
- `G'` = candidate amended graph;
- `D` = confirmed/DONE transitions;
- `A` = live transitions with authoritative in-flight execution state.

Before accepting the change, Overcenter should prove at least the following.

### 8.1 Candidate static soundness

`G'` must independently satisfy every `project.define` structural correctness property.

### 8.2 Confirmed-history preservation

Every confirmed transition must retain compatible meaning.

At minimum:

- confirmed transitions cannot be removed;
- their execution semantics cannot be rewritten in place;
- they cannot gain a prerequisite that was not satisfied when they executed.

The current confirmed-transition immutability rule is an excellent foundation, but dependency changes deserve explicit reachability treatment.

### 8.3 Predecessor closure under the candidate graph

The existing completed set `D` must still be predecessor-closed in `G'`.

If the amended graph says completed transition `X` depends on `Y`, but `Y` is not already complete, the amendment invents a causal history that never occurred and must be rejected.

This single check catches a broad class of dangerous amendments.

### 8.4 In-flight transition compatibility

For each `a ∈ A`, one of the following must hold:

1. the transition still exists with execution-relevant meaning unchanged; or
2. the amendment is being applied through an explicit safe replan/recovery protocol that accounts for the active execution.

An ordinary `project.amend` should not silently delete or rewrite work that is currently leased, executing, committing, or confirming.

### 8.5 No new unsatisfied prerequisites for active work

An already-started transition must not gain a prerequisite that was not satisfied at the authoritative point at which it started.

Doing so retroactively invalidates the enablement condition under which the work was legitimately acquired.

### 8.6 No removal of live execution state

Deleting a graph node must not erase evidence that execution associated with that node is still active or may have externally mutated state.

Graph mutation and execution recovery must remain separate responsibilities.

### 8.7 Completion remains reachable

After mapping the existing completed and active state into `G'`, the remaining graph must retain a valid topological completion path under nominal execution assumptions.

For the current DAG this can be checked without general state-space exploration.

## 9. Change regions

Van der Aalst's dynamic-change work motivates a particularly useful Overcenter abstraction: the **change region**.

An amendment's effect is larger than the literal list of nodes edited. A changed dependency may alter synchronization or causal assumptions for downstream work that is textually untouched.

Overcenter should compute a conservative affected region from the structural diff.

A useful model is:

```text
                  structural diff
                       |
                       v
             changed transitions/edges
                       |
             expand to affected causal
              / synchronization region
                       |
                       v
                 CHANGE REGION C
                       |
             +---------+----------+
             |                    |
       C ∩ live = empty      C ∩ live != empty
             |                    |
           amend             postpone/replan
```

For the present dependency DAG, the exact minimal region can be defined conservatively through changed nodes plus the ancestors/descendants whose enablement or synchronization predicates are affected.

The implementation does not need to reproduce the full theoretical machinery from dynamic Petri-net migration. The useful product rule is:

> A normal `project.amend` must not migrate a workflow through a change region occupied by live execution.

If the region is occupied, return a typed fail-closed result identifying the blocking transition/run/lease or route through a purpose-built dynamic-replan/recovery path.

## 10. Dynamic prerequisite discovery

Overcenter's existing dynamic-replan concept maps cleanly onto safe workflow migration.

A useful semantic distinction is:

```text
agent EXECUTE
    !=
authoritative workflow transition firing

COMMIT + CONFIRM
    ~=
authoritative state transition
```

Speculative execution may discover that a transition actually requires a missing prerequisite. If the system then commits and confirms a graph amendment that makes the selected transition WAITING or otherwise non-executable, the workflow history has not been falsified because the transition was not authoritatively completed.

Once confirmation establishes completion, however, the causal meaning of that transition must become immutable.

This suggests an explicit rule:

> Pre-confirmation execution may trigger structured replanning; post-confirmation history is authoritative causal fact.

That is a strong composition of workflow theory with Overcenter's transaction/evidence model.

## 11. Cancellation should remain deliberately constrained

Cancellation is one of the places where workflow languages rapidly become harder to analyze.

Petri-net extensions often model cancellation using reset arcs or cancellation regions that remove tokens from parts of the workflow. This adds expressive power but weakens classical decidability and verification properties. Unrestricted reset behavior is not a good fit for Overcenter's goal of mechanically verified project transitions.

Recommendation:

> Do not introduce a generic operation equivalent to "cancel X and erase arbitrary descendant execution state."

If cancellation becomes necessary, represent it as a constrained, explicit state transition with mechanically analyzable scope.

A cancellation construct should declare at least:

- the bounded set/region it affects;
- whether cancelled work counts as terminal for joins;
- whether cancellation propagates downstream;
- what happens to already-started work;
- what compensation/reconciliation obligations remain;
- whether the project terminates as completed, cancelled, or failed.

Then validate mechanically that:

- no AND-join permanently awaits a branch that cancellation removed;
- no cancellation erases live external mutation uncertainty;
- no irreversible committed work is silently treated as undone;
- cancellation regions are structurally closed enough to analyze;
- terminal project state contains no contradictory active work.

Cancellation should be modeled as new authoritative truth, not deletion of inconvenient history.

## 12. Structured branching if Overcenter ever needs choice

The current DAG avoids conflict/choice entirely. That is worth preserving as the default profile.

If project graphs eventually need alternative branches, prefer **well-structured** constructs with explicit single-entry/single-exit regions and matching split/join semantics.

For example:

```text
choice-start
   |-- branch A --|
   |-- branch B --| -> choice-join
```

The split should record which branch or branches were selected, and the corresponding join should derive readiness from that explicit selection evidence.

This is much safer than a generic OR-join that asks at runtime whether another branch "might still arrive."

A useful language-design principle is:

> Add only graph constructs whose soundness and migration rules Overcenter can continue to decide mechanically.

Expressiveness should not outrun verification.

## 13. Recommended validation boundary

The workflow analyzer should be a pure deterministic layer invoked before any project-authoring mutation.

Conceptually:

```text
project.define
    |
    +-- canonicalize definition
    +-- validate schema/contracts
    +-- analyze static workflow correctness
    +-- derive correctness certificate
    +-- exact-authority fenced mutation
    +-- authoritative readback

project.amend
    |
    +-- read exact current definition
    +-- read authoritative confirmed + live state
    +-- apply amendment in memory
    +-- analyze candidate static correctness
    +-- analyze state-migration compatibility
    +-- compute/check change region
    +-- exact-authority fenced mutation
    +-- authoritative readback
```

The analyzer should not own mutation, leases, Git revision checks, recovery, or provider behavior. It should consume authoritative inputs and return deterministic facts or typed failures.

This preserves Overcenter's core separation:

- Git/source authority establishes what graph revision is current;
- execution state establishes what has actually happened;
- the workflow analyzer establishes whether the candidate graph/state combination is causally valid;
- project-authoring machinery owns the exact-revision mutation and readback protocol.

## 14. Suggested mechanical checks by command

### `project.define`

Reject before mutation if any of the following fail:

1. canonical schema validity;
2. unique transition identities;
3. referential integrity;
4. no self-dependencies;
5. acyclicity;
6. every node lies between synthetic start and end;
7. no structurally dead transition;
8. nominal deadlock freedom;
9. safeness under the all-of DAG profile;
10. proper-completion structure;
11. option-to-complete under nominal execution assumptions;
12. all joins/splits use supported explicit semantics.

Return or retain a deterministic correctness certificate keyed to the canonical definition/revision.

### `project.amend`

Perform every `project.define` check against the candidate graph, plus:

1. exact current execution-state read;
2. confirmed-history preservation;
3. predecessor closure of confirmed work under the candidate graph;
4. active transition compatibility;
5. no retroactive unsatisfied prerequisite for in-flight work;
6. no deletion/rewrite of live execution state outside an explicit migration protocol;
7. change-region computation;
8. rejection/postponement if live state occupies the change region;
9. candidate-state reachability;
10. completion remains possible from the migrated state;
11. no new unexplained quiescent/deadlock state;
12. authoritative readback after mutation still satisfies the same graph/state invariants.

## 15. What not to implement

This research does **not** recommend:

- a general Petri-net runtime;
- token objects persisted as a second execution truth;
- a second scheduler alongside Overcenter's existing transition lifecycle;
- generic state-space exploration for today's DAGs;
- unrestricted cycles;
- implicit XOR/OR behavior;
- unrestricted reset arcs/cancellation;
- graph validation that pretends to prove external-provider success.

Petri nets are most valuable here as a theory of invariants, not as a new storage or orchestration architecture.

## 16. Architectural conclusions

### Preserve the restricted graph profile

The current all-of DAG is close to an ideal verification target: it supports concurrency and synchronization while avoiding conflict, cycles, ambiguous joins, and arbitrary token deletion.

### Make workflow correctness explicit

Overcenter should be able to state, with evidence, not merely that a graph parsed successfully but that it satisfies a named correctness profile.

A reasonable initial profile name would be something like:

```text
overcenter-and-dag-v1
```

The name is intentionally boring. It should describe a machine-checkable semantic contract.

### Treat live amendments as workflow migration

This is the highest-value lesson from dynamic workflow research.

The safe question is not:

> Is the amended graph valid?

It is:

> Is the amended graph valid, and is the exact current execution state a legal, completion-preserving state of that graph?

### Use specialized reachability rather than generic reachability

For the current graph profile, predecessor closure plus active-enabledness checks provide an exact and inexpensive analogue of marking reachability.

Do not solve a harder problem than Overcenter's language creates.

### Keep correctness properties at the semantic boundary

`project.define` and `project.amend` are the right places to reject incorrect graph changes because they are the semantic authoring boundaries. Agents should not be responsible for manually proving soundness, recomputing causal closures, or reasoning about whether a live amendment is safe.

Those are deterministic responsibilities and should live behind the commands.

## 17. Proposed minimal implementation sequence

A minimal, high-leverage sequence would be:

1. Define a pure `analyzeProjectWorkflow(definition)` function for the current all-of DAG profile.
2. Return a typed static correctness report/certificate.
3. Call it from both `project.define` and candidate construction in `project.amend` before mutation.
4. Define a canonical authoritative execution-state snapshot for graph-migration analysis.
5. Add predecessor-closure validation for confirmed transitions.
6. Add compatibility checks for in-flight transitions.
7. Compute a conservative amendment change region.
8. Reject ordinary amendments that intersect live execution.
9. Allow occupied-region changes only through an explicit replan/recovery protocol.
10. Add runtime invariant checking for `incomplete && no READY` states so structural deadlock is distinguishable from off-nominal blockage.

This adds strong workflow guarantees without changing the primary graph language or introducing a Petri-net runtime.

## 18. Research references

Primary and closely related prior art consulted for the concepts above:

- W. M. P. van der Aalst, **The Application of Petri Nets to Workflow Management**, Journal of Circuits, Systems and Computers, 1998. Introduces workflow nets and the classical soundness framing.
- W. M. P. van der Aalst, **Verification of Workflow Nets**, ICATPN 1997. Develops soundness analysis and the relationship between WF-net soundness and liveness/boundedness of the short-circuited net.
- W. M. P. van der Aalst and A. H. M. ter Hofstede, **YAWL: Yet Another Workflow Language**, Information Systems, 2005. Relevant for workflow patterns, synchronization, cancellation regions, and the limits of simple workflow constructs.
- W. M. P. van der Aalst, **Exterminating the Dynamic Change Bug: A Concrete Approach to Support Workflow Change**, Information Systems Frontiers, 2001. Directly relevant to safe migration of running workflow instances under process-model changes and the idea of affected/change regions.
- W. M. P. van der Aalst et al., workflow-pattern literature on control-flow patterns, especially AND/XOR/OR split and join semantics, cancellation, and multiple-instance behavior.
- Research on **soundness of workflow nets with reset arcs**, relevant to the increased verification difficulty introduced by unrestricted cancellation/reset semantics.
- Research on **well-structured workflow nets/process models**, relevant to keeping branching and synchronization constructs compositional and mechanically analyzable.

Useful source locations include van der Aalst's publication archive at `vdaalst.com/publications/` and the Eindhoven University of Technology research repository.

## 19. Final recommendation

Petri-net theory points Overcenter toward a stronger version of its existing design philosophy:

> Keep agent reasoning at the judgment boundary. Move causal consistency, workflow soundness, reachability checks, deadlock detection, and safe graph-migration rules into deterministic software.

The most important concrete addition is an amendment-time invariant:

> **The exact confirmed and in-flight project state must be a causally valid, completion-preserving state of the candidate amended graph.**

If Overcenter can prove that mechanically before `project.amend` mutates authority, dynamic graph evolution becomes a verified state transition rather than a hopeful rewrite of the plan.