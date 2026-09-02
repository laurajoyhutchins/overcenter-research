# Kubernetes and Flux Reconciliation as Prior Art for Overcenter

**Date:** 2026-09-02  
**Status:** Research note  
**Scope:** Kubernetes controller semantics and Flux reconciliation patterns, compared with Overcenter's graph/frontier/project-transition model.

## Executive conclusion

Kubernetes and Flux are strong prior art for the **outer control loop** of Overcenter: continuously derive current project state from authoritative desired state and observations, compute what is ready, retry safe/reconcilable work, repair drift, and converge without asking an agent to maintain bookkeeping.

They are weaker prior art for the **inner transition boundary** where Overcenter needs to make a durable claim that a consequential operation actually happened under valid authority and may safely unlock downstream work.

The architectural split should therefore be explicit:

```text
                 RECONCILIATION PLANE
 repo desired state -> observe -> derive graph/frontier
        ^                           |
        |                           v
        +------ retry / drift / re-evaluate
                                    |
                           READY transition
                                    v
                 +-----------------------------+
                 | TRANSACTION / SETTLEMENT    |
                 | acquire exact authority     |
                 | execute bounded effect      |
                 | resolve mutation certainty  |
                 | commit + fresh confirm      |
                 +-----------------------------+
                                    |
                                    v
                          reconciliation resumes
```

The concise rule is:

> **Reconcile everything that can safely be recomputed. Settle everything whose ambiguity would make the next project transition unsafe.**

Overcenter should become more Kubernetes-like outside a project transition and deliberately stronger than Kubernetes inside it.

---

## 1. Kubernetes controller model

Kubernetes controllers are non-terminating control loops. They observe current state, compare it with desired state, act to make current state closer to desired state, and repeat. Kubernetes explicitly assumes the system may be changing continuously and need never reach a globally static condition as long as controllers continue making useful progress toward desired state.

The important architectural property is that a controller does not encode project history as an imperative script. It repeatedly asks a fresh question:

```text
What is desired now?
What is observed now?
What delta can I safely act on now?
```

This produces several desirable properties:

- a controller can crash and restart without reconstructing an entire imperative history;
- transient failures can be retried;
- drift can be repaired later;
- current state is derived from authoritative resources rather than a manually maintained work queue;
- multiple controllers can own separate concerns;
- progress is driven by current predicates, not by remembering that a previous process once intended to perform step N.

This model is a strong match for Overcenter's graph/frontier derivation.

### Sources

- Kubernetes, **Controllers**: https://kubernetes.io/docs/concepts/architecture/controller/
- Kubernetes, **Custom Resources / Custom Controllers**: https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/

---

## 2. Desired state vs observed state

Kubernetes resources commonly separate:

- `spec`: desired state supplied by the user or another controller;
- `status`: observations produced by controllers about current state.

For Overcenter, the corresponding split should be:

```text
desired state
    =
repository-owned project definition
at an exact Git revision
interpreted by a deterministic derivation contract

observed state
    =
fresh observations from systems that own the relevant facts
```

Examples of observed facts include:

- exact Git branch or pull-request head;
- check/review state;
- Overcenter execution authority and settlement state;
- unresolved mutation state;
- deployment identity;
- retained object identity;
- other provider-specific exact coordinates.

This is stronger than treating a project graph as a mutable queue. The graph should be a deterministic answer to:

> Given authoritative desired state and current authoritative observations, what transitions exist, what predicates are satisfied, and what is executable now?

### Recommendation

Keep the project graph and frontier **derived**. Do not introduce a separately authoritative planner database, agent-maintained queue, or task tracker that must be synchronized with the repository definition.

This is the first major Kubernetes lesson worth adopting wholesale.

---

## 3. `generation`: identify the desired state that status refers to

Kubernetes uses `metadata.generation` to represent changes to an object's desired configuration. Controllers often publish `status.observedGeneration` to identify which generation they actually evaluated.

This addresses an important stale-status problem:

```text
metadata.generation = 12
status.observedGeneration = 9

=> the reported status is stale relative to current desired state
```

Kubernetes condition APIs explicitly describe an older `observedGeneration` as out of date with respect to the current resource state.

Flux depends heavily on the same idea. A Kustomization reports the latest generation that resulted in either a ready state or a conclusively stalled state.

### Overcenter mapping

Overcenter already has a stronger natural desired-state coordinate than an incrementing integer: an exact Git revision plus deterministic derivation version.

Prefer:

```text
definition_coordinate = {
  repository,
  revision: exact_git_sha,
  derivation_version
}
```

over inventing a synthetic project `generation` as the correctness identity.

A human-friendly sequence number can exist if useful, but correctness should bind to the exact content coordinate.

### Recommendation

Every graph/frontier/status response should expose the desired-state coordinate it was evaluated against. Any READY, BLOCKED, DONE, dependency-satisfied, or verification claim whose observation belongs to a superseded desired-state coordinate must be mechanically recognizable as stale.

This is the Kubernetes `observedGeneration` pattern upgraded to content-addressed project state.

### Sources

- Kubernetes, **CustomResourceDefinition condition `observedGeneration` semantics**: https://kubernetes.io/docs/reference/kubernetes-api/extend-resources/custom-resource-definition-v1/
- Kubernetes, **DeploymentStatus `observedGeneration`**: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/deployment-v1/
- Flux, **Kustomization status / observed generation**: https://fluxcd.io/flux/components/kustomize/kustomizations/

---

## 4. `resourceVersion`: optimistic concurrency and exact authority

Every Kubernetes object has a `metadata.resourceVersion`, an opaque value identifying the persisted version of that resource. Clients can use it for change detection, watches, and optimistic concurrency.

For an update that includes a `resourceVersion`, Kubernetes detects lost updates. If the object changed after the client read it, the API server rejects the stale update with `409 Conflict` rather than silently overwriting the newer state.

The Overcenter analogue is exact-revision mutation:

```text
read authority @ A
       |
       v
perform mutation expecting A
       |
   +---+---+
   |       |
still A   changed to B
   |       |
commit    reject / re-read
```

This is conceptually close to Kubernetes optimistic concurrency, but Overcenter spans multiple authorities and therefore should not pretend one global project revision can represent all concurrency-sensitive facts.

### Recommendation: use an authority vector

Represent the exact coordinates relevant to a transition explicitly:

```text
observed_authority = {
  definition_revision: <git sha>,
  transition_head: <git/pr sha>?,
  lease_epoch: <epoch>?,
  provider_revision: <opaque provider coordinate>?,
  retained_object_id: <identity>?
}
```

Each predicate or mutation contract should declare which coordinates matter.

Do **not** collapse this into a synthetic `projectResourceVersion` if doing so hides independent authorities or creates false atomicity.

### Source

- Kubernetes, **API Concepts / updates to existing resources / resourceVersion and 409 Conflict**: https://kubernetes.io/docs/reference/using-api/api-concepts/
- Kubernetes, **ObjectMeta / resourceVersion**: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/object-meta/

---

## 5. Reconciliation loops map directly to graph/frontier recomputation

The most direct Kubernetes-to-Overcenter mapping is:

```text
         authoritative desired state
                    |
                    v
             graph reconciliation
                    |
        +-----------+-----------+
        v           v           v
    node state  dependencies  horizons
        |           |           |
        +-----------+-----------+
                    v
                 frontier
                    |
          +---------+---------+
          v                   v
 deterministic work      judgment needed
```

A fresh reconciliation should be triggered when any relevant authority changes, including:

- repository desired state changes;
- exact GitHub observations change;
- CI/review status changes;
- settlement completes;
- a lease expires;
- unresolved operation certainty is resolved;
- verification changes;
- a recovery action establishes new facts.

Event-driven reconciliation should be preferred when events exist, with periodic reconciliation as a safety net for missed events or external drift. Flux follows this pattern: normal interval-based reconciliation is supplemented by immediate reaction to generation or source-revision changes.

### Recommendation

Treat the executable frontier as **reconciler output, never stored queue truth**.

This removes a large class of agent bookkeeping problems. A crashed agent, stale Linear projection, or missed scheduler cycle should not corrupt what work is actually READY.

---

## 6. Flux `dependsOn` and Overcenter dependency predicates

Flux `Kustomization.spec.dependsOn` prevents a Kustomization from applying until its dependencies are ready. Circular dependencies never become applicable.

That maps closely to Overcenter graph edges:

```text
A DONE -----+
            +--> C READY
B DONE -----+
```

More interestingly, Flux supports `readyExpr`, a CEL expression for custom dependency readiness. Its documented lockstep-upgrade example can require:

- the dependency's semantic readiness condition to be true;
- version labels to match;
- the dependency's `metadata.generation` to equal `status.observedGeneration`.

This demonstrates a valuable principle:

> A dependency is not satisfied merely because some old observation once said `Ready`; the observation must also correspond to the required current desired state.

### Recommendation

Make every Overcenter dependency predicate freshness-sensitive.

Semantically:

```text
C is READY iff
    dependency_predicate(A) == satisfied
    AND observation(A) is valid for required authority coordinates
```

A stale successful observation should not unlock downstream work.

### Source

- Flux, **Kustomization dependencies and `readyExpr`**: https://fluxcd.io/flux/components/kustomize/kustomizations/

---

## 7. Conditions are useful, but they should remain derived

Kubernetes Conditions provide a compact, machine-readable explanation of important resource properties. Common fields include:

- `type`;
- `status`: `True`, `False`, or `Unknown`;
- `reason`;
- `message`;
- `observedGeneration`;
- `lastTransitionTime`.

Flux uses conditions such as:

- `Reconciling`;
- `Ready`;
- `Stalled`;
- `ProgressingWithRetry` reasons.

Importantly, a resource can be reconciling while also currently failing. Conditions therefore capture orthogonal facts without exploding the main lifecycle into dozens of mutually exclusive states.

### Overcenter mapping

Keep the primary project lifecycle compact, for example:

```text
READY
EXECUTING
WAITING
BLOCKED
DONE
```

Then expose orthogonal derived conditions such as:

```yaml
state: BLOCKED
conditions:
  - type: AuthorityCurrent
    status: true
  - type: MutationResolved
    status: false
    reason: ExternalEffectIndeterminate
  - type: RecoveryRequired
    status: true
    reason: ReadbackMismatch
```

### Recommendation

Adopt a standardized Condition vocabulary, but do not let condition rows become a new source of authority. They should be deterministic projections over current execution state, unresolved operations, proof state, and fresh external observations.

### Sources

- Kubernetes, **Pod Conditions**: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-conditions
- Flux, **Kustomization conditions**: https://fluxcd.io/flux/components/kustomize/kustomizations/

---

## 8. Retries: adopt Flux's model only for retry-safe work

Flux distinguishes normal reconciliation intervals from retry intervals for failed reconciliation. Failed Kustomizations continue retrying, with controller backoff behavior, until they succeed or become conclusively stalled.

That behavior is appropriate for operations such as:

```text
read provider state
recompute graph
check CI
ensure a projection exists
refresh status
apply an idempotent declarative configuration
repair drift
```

It is unsafe to apply the same generic rule to potentially non-idempotent or irreversible effects:

```text
merge pull request
publish release
perform irreversible migration
send externally consequential message
advance an external state machine
any mutation whose prior result is unknown
```

For an ambiguous mutation, this is wrong:

```text
error -> retry mutation
```

The correct flow is:

```text
error
  |
  v
may have mutated?
  |
 yes
  |
  v
read authoritative state
  |
  +--> effect proven present -> continue from established fact
  |
  +--> effect proven absent  -> retry only if contract permits
  |
  +--> unresolved            -> fail closed / recovery required
```

### Recommendation

Every mutation contract should declare its recovery class, at minimum distinguishing:

- observational/read-only;
- retryable and idempotent;
- reconcilable;
- compensatable;
- irreversible but confirmable;
- potentially mutating with ambiguous outcome.

Retry behavior should be derived from the operation contract, never inferred from a generic orchestration error handler.

---

## 9. Finalizers map well to unresolved obligations

Kubernetes finalizers prevent an object from being fully deleted until named cleanup obligations have been satisfied. A delete request sets `deletionTimestamp`; the object remains terminating until controllers clear its finalizers.

The useful Overcenter idea is broader than deletion:

> Do not discard the compact state required to resolve an externally significant uncertainty while that uncertainty remains relevant to safe continuation.

For example:

```text
run wants to terminate
        |
        v
unresolved mutation exists?
        |
       yes
        |
        v
retain recovery obligation
        |
reconcile external authority
        |
        v
certainty established
        |
        v
terminal compact receipt / tombstone
```

### Recommendation

Adopt **finalization obligations** as a semantic concept, but make them stronger than Kubernetes finalizer strings.

An Overcenter finalization obligation should bind to structured state such as:

- unresolved operation identity;
- authority coordinates;
- mutation certainty;
- required recovery/confirmation action;
- terminal resolution evidence.

Do not use a bare string merely meaning "some controller still owes cleanup" when the unresolved effect affects project truth.

### Source

- Kubernetes, **Finalizers**: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/

---

## 10. Eventual convergence is the right graph-level abstraction

At project level, eventual convergence is exactly the right model.

A project is not required to move through one unbroken imperative execution. Desired state may change while work is happening. External systems may lag. Agents may stop. Controllers may restart. CI may take time. A transition may become READY, then cease to be READY when authority changes.

The desired property is:

> Repeated authoritative observation plus safe deterministic action should converge the project toward the currently declared graph state whenever the environment permits it.

This means Overcenter should be comfortable with:

- repeated graph evaluation;
- repeated predicate evaluation;
- stale projection repair;
- abandoned session recovery;
- event-triggered and periodic rechecks;
- deriving DONE from authoritative facts rather than remembered procedural history.

This is pure controller territory.

---

## 11. Where Kubernetes' convergence semantics are not strong enough

Kubernetes' API offers strong optimistic concurrency on individual objects, but controllers commonly coordinate multi-object and external-system effects through repeated reconciliation rather than through one distributed transaction.

A controller may conceptually:

```text
create A
update B
call cloud API
crash
```

The general recovery mechanism is to observe again and reconcile toward desired state.

For infrastructure management, this is often the correct tradeoff.

Overcenter, however, frequently needs to make a stronger statement:

> This exact project transition was executed under valid bounded authority; its external effect has known certainty; required resulting state was freshly observed; and only then was downstream project state unlocked.

That is not merely eventual convergence. It is **transactional settlement of a semantic project transition**.

### Key distinction

```text
Kubernetes question:
"Is reality converging toward the declared configuration?"

Overcenter transition question:
"May I truthfully and safely assert that this transition completed and permit dependents to proceed?"
```

The second requires stronger evidence.

---

## 12. `Ready` is not equivalent to settled

Flux exposes useful revision distinctions including:

- `status.lastAttemptedRevision`;
- `status.lastAppliedRevision`;
- `status.observedGeneration`;
- readiness and health conditions.

Overcenter should retain comparable distinctions, but go further:

```text
attempted coordinate
        |
        v
effect certainty
        |
        v
authority-after observation
        |
        v
result verification
        |
        v
settlement
```

These are not synonyms.

A command can return success while the intended resulting state is not yet verified. An ambiguous provider response can leave an effect possibly present even if the command did not report success. A fresh external observation can resolve mutation certainty without proving every semantic postcondition of the transition.

### Recommendation

Never collapse:

- invocation outcome;
- mutation certainty;
- resulting-state verification;
- transition settlement.

Flux's attempted/applied split is good prior art. Overcenter should deliberately retain a stronger evidence model because it is producing project truth rather than only maintaining a declarative workload.

### Source

- Flux, **Kustomization status (`lastAttemptedRevision`, `lastAppliedRevision`, conditions, observed generation)**: https://fluxcd.io/flux/components/kustomize/kustomizations/

---

## 13. `project.advance` should reconcile to a semantic boundary

The Kubernetes/Flux model suggests a clean definition for `project.advance`:

> Reconcile the project as far as deterministic software safely can, crossing transactional transition boundaries under exact authority, until the project is satisfied, blocked/waiting, or genuine agent judgment is required.

Conceptually:

```text
project.advance(project)

loop:
    graph = reconcileProjectFromFreshAuthority()

    if selected horizon is satisfied:
        return DONE

    resolve deterministic recovery that is mechanically knowable
    reconcile disposable projections
    retry retry-safe observations/effects

    transition = choose READY transition

    if none:
        return WAITING or BLOCKED

    if transition requires judgment:
        return decision_packet

    settleTransition(transaction)

    # then loop from fresh authority rather than trusting stale local state
```

This makes the happy path simple while keeping execution correctness in deterministic software.

The agent should not manually perform:

```text
inspect -> claim -> heartbeat -> retry -> reconcile -> settle -> recompute frontier
```

when those steps are mechanically determined.

---

## 14. `project.amend` should remain transactional, not eventually consistent

A graph amendment changes desired state itself. This is analogous to changing Kubernetes `spec`, not to running a controller against the existing spec.

Because Overcenter graph changes determine what work can become executable, an amendment deserves an exact conditional mutation boundary:

```text
read desired state @ revision A
        |
        v
mechanically validate proposed graph
        |
        v
conditional repository mutation A -> B
        |
        v
freshly reread repository authority
        |
        v
re-derive graph @ B
        |
        v
confirm requested semantic change exists
```

Do not weaken this into:

```text
write something
controller will eventually notice
```

Reconciliation is appropriate **after** the authoritative desired-state mutation has been safely established.

---

## 15. Cancellation should use convergence plus finalization, not fictional rollback

Kubernetes deletion/finalizer behavior offers a useful cancellation model.

Cancellation first changes desired state:

```text
transition desired: active
          ->
transition desired: cancelled
```

Then reconciliation determines what remains necessary.

### No significant effect occurred

```text
cancel -> CANCELLED
```

### Safe cleanup or compensation remains

```text
CANCELLING
    |
    v
reconcile cleanup obligations
    |
    v
CANCELLED
```

### Prior effect is ambiguous

```text
CANCELLING
    |
    v
resolve mutation certainty
    |
    +--> proven absent -> CANCELLED
    +--> present and compensatable -> compensate/reconcile
    +--> unresolved -> BLOCKED_RECOVERY
```

Cancellation can therefore be eventually convergent, while **permission to declare cancellation complete** remains evidence-backed.

---

## 16. Two-engine architecture

The clearest synthesis is to describe Overcenter internally as two cooperating engines.

### A. Project reconciler

Owns mechanically repeatable convergence.

Responsibilities:

- read desired graph;
- read authoritative observations;
- derive node lifecycle predicates;
- recompute dependency satisfaction;
- recompute frontier;
- derive horizon state;
- detect stale observations;
- repair non-authoritative projections;
- retry safe observations;
- invoke deterministic recovery when outcome is mechanically knowable;
- detect drift and newly satisfied predicates.

Properties:

```text
repeatable
idempotent or reconcilable
event-driven with periodic fallback
restart-safe
eventually convergent
```

### B. Transition settlement kernel

Owns claims that cannot safely be inferred from eventual convergence alone.

Responsibilities:

- exclusive/bounded execution authority;
- exact-revision fencing;
- idempotency identity;
- controlled effect execution;
- mutation certainty;
- fresh authority-after observation;
- explicit semantic verification;
- settlement;
- ambiguous-effect recovery.

Properties:

```text
bounded
authority-fenced
exact-coordinate
fail-closed
evidence-backed
explicitly terminal
```

Relationship:

```text
reconciler
   |
 finds READY
   v
settlement kernel
   |
 settles one verified transition
   v
reconciler
```

This is the main architectural result of the comparison.

---

## 17. Concrete recommendations

### 17.1 Formalize desired vs observed terminology

Use Kubernetes' vocabulary consistently:

- repository project definition = desired state;
- authoritative provider/runtime reads = observed state;
- graph/frontier = deterministic reconciliation result.

### 17.2 Expose exact observed-definition identity everywhere

Any decision-relevant status should reveal which desired-state coordinate it was evaluated against. Use exact Git/derivation coordinates rather than a correctness-critical numeric generation counter.

### 17.3 Treat frontier as disposable derivation

Never require imperative updates to a queue to make work READY or DONE if those states can be derived from authority.

### 17.4 Make dependency satisfaction freshness-aware

A prerequisite is satisfied only when both its semantic predicate and required authority-coordinate freshness hold.

Flux `readyExpr` plus `observedGeneration` is especially useful prior art here.

### 17.5 Add derived Conditions

Keep the primary lifecycle small. Add orthogonal, machine-readable conditions for:

- authority freshness;
- reconciliation progress;
- verification;
- mutation certainty;
- recovery requirement;
- terminal stalls.

### 17.6 Make retry policy part of operation semantics

Do not have generic orchestration infer retry safety from exceptions. Operations should declare whether they are retryable, idempotent, reconcilable, compensatable, confirmable, or ambiguity-sensitive.

### 17.7 Introduce structured finalization obligations

Retain compact current state while unresolved external effects could affect safe continuation. Delete historical execution detail aggressively once compact terminal evidence is sufficient, but never delete the facts required to resolve active ambiguity.

### 17.8 Keep attempted, applied, confirmed, verified, and settled distinct

Borrow Flux's revision/status distinctions but preserve Overcenter's stronger mutation-certainty and verification boundaries.

### 17.9 Make `project.advance` reconcile-to-quiescence

It should internally absorb stale observations, safe retries, projection repair, deterministic recovery, and repeated frontier recomputation before returning control to an agent.

### 17.10 Keep desired-state amendment exact and synchronous

`project.define` / `project.amend` should mechanically validate, perform exact conditional repository mutation, reread authority, and confirm the new derived graph before reporting success.

---

## 18. Where reconciliation is the right abstraction

Use reconciliation for operations whose correctness can be established from current desired and observed state and which can safely be repeated or repaired:

| Area | Reconciliation fit | Why |
|---|---:|---|
| Graph derivation | Excellent | Pure derivation from authority |
| Frontier computation | Excellent | Recomputable, should never be queue truth |
| Dependency evaluation | Excellent | Predicate-based and freshness-sensitive |
| Horizon evaluation | Excellent | Derived closure over current graph |
| Linear/task projection | Excellent | Projection is not authority |
| Dashboards/status caches | Excellent | Disposable materialization |
| CI/readiness observation | Excellent | Re-read until predicate changes |
| Drift repair | Excellent | Canonical controller problem |
| Expired/stale coordination cleanup | Excellent when deterministic | Current facts determine safe repair |
| External declarative configuration | Good | If apply is truly idempotent/reconcilable |
| Cancellation cleanup | Good | When obligations are explicit and effects known |

---

## 19. Where stronger transactional settlement is required

Use the settlement kernel when an ambiguous or stale result could falsely unlock downstream project work:

| Area | Reconciliation alone? | Stronger requirement |
|---|---:|---|
| Exact repository mutation | No | Compare-and-swap / exact old revision |
| Project graph amendment | No | Validate + conditional commit + fresh readback |
| PR merge | No | Exact head/base assumptions + mutation certainty + confirm |
| Production promotion | No | Bounded authority + exact inputs + durable result evidence |
| Release publication | No | Idempotency identity + externally confirmed result |
| Non-idempotent provider mutation | No | Resolve indeterminate outcome before retry |
| Work completion settlement | No | Evidence-backed postconditions |
| Unlocking dependent transitions | No | Fresh verified predecessor state |
| Irreversible migration | No | Explicit preconditions, result verification, recovery contract |
| Ambiguous cross-system mutation | No | Fail closed until authority resolves certainty |

---

## 20. Final synthesis

Kubernetes' key insight is:

> Do not model a changing system as a fragile imperative script. Continuously derive the difference between desired and observed state and act on that difference.

Overcenter should take that lesson deeply into its project graph, frontier, projection, retry, recovery, and status architecture.

But Overcenter has a different responsibility at the moment a semantic project transition becomes truth:

> Eventual convergence is not evidence that a consequential transition settled correctly.

The resulting model is:

```text
Kubernetes / Flux reconciliation
            +
exact-revision concurrency control
            +
mutation certainty
            +
bounded execution authority
            +
explicit verification evidence
            =
Overcenter's natural architecture
```

The reconciler answers:

> **What should happen next given current truth?**

The settlement kernel answers:

> **What may we safely claim happened?**

Keeping those questions separate should make Overcenter both simpler and stricter: simple where repeated deterministic convergence is sufficient, strict where an incorrect claim would contaminate downstream project truth.
