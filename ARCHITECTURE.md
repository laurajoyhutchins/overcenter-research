# Overcenter Architecture Model

## One-sentence model

> Overcenter treats project state as a derived claim over immutable intent, exact authority, externally observed effects, verification evidence, and settlement, while treating execution workers as disposable producers of candidate realizations.

The architecture is intentionally split so that reasoning can remain probabilistic while execution correctness is owned by deterministic machinery.

```text
immutable project intent
        |
        v
obligation derivation / reuse
        |
        v
narrow authority kernel
        |
        v
disposable execution
        |
        v
external effect
        |
        v
authoritative observation
        |
        v
verification
        |
        v
settlement
        |
        v
durable proof
        |
        v
derived project truth
```

The key boundary is not "agent versus database." It is:

```text
producer of candidate effects
            !=
authority that decides project truth
```

## Architecture at a glance

```text
+------------------------------------------------------------------+
|                      IMMUTABLE PROJECT INTENT                    |
|                                                                  |
| graph revision   obligations   dependencies   verifier semantics |
| exact inputs     policies      acceptance predicates             |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                    DERIVATION / REUSE LAYER                      |
|                                                                  |
| Is the obligation structurally enabled?                          |
| Does an acceptable realization already exist?                    |
| Which dependencies changed?                                      |
| What is READY / BLOCKED / already satisfied?                     |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                  NON-MONOTONIC AUTHORITY KERNEL                  |
|                                                                  |
| current revision   claim / lease   fencing epoch                 |
| unresolved effect reservation   exact-current checks             |
| effect conflict / ordering      CAS settlement                   |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                     DISPOSABLE EXECUTION                         |
|                                                                  |
| reasoning agent   deterministic tools   build/test workers       |
| local checkout    cache                 process memory            |
|                                                                  |
|      may disappear completely; none of this is project truth     |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                       EXTERNAL EFFECTS                           |
|                                                                  |
| Git / GitHub / cloud / SaaS / filesystem / database / messages  |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                OBSERVATION / VERIFICATION / SETTLEMENT           |
|                                                                  |
| canonical readback -> mutation certainty -> predicate check      |
| -> authority revalidation -> CAS settlement                      |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                    MONOTONIC DURABLE EVIDENCE                    |
|                                                                  |
| observations   verification facts   receipts   settlements       |
| completion certificates   attestations   amendment ancestry      |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                     CURRENT PROJECT PROJECTION                   |
|                                                                  |
| READY   EXECUTING   WAITING   BLOCKED   RECOVERY_REQUIRED   DONE |
+------------------------------------------------------------------+
```

The bottom row is a **projection**, not the deepest source of truth.

## Durable authority implementation

The authority kernel consumes a deliberately small storage contract:

```text
head()
append(expected head, durable fact transition)
history(head)
```

The production implementation is SQLite. It stores immutable fact commits plus one authority row. Each transition runs under `BEGIN IMMEDIATE`: validate the exact expected head, insert the immutable fact commit, advance the authority head, then commit. WAL mode and `synchronous=FULL` are enabled. A stale expected head rolls the transaction back and leaves no durable fact behind.

```text
fact_commits
  sequence
  commit_id
  parent_id
  message
  files_json

authority
  singleton
  head
  sequence
```

There is intentionally no privileged lifecycle/status table. `READY`, `EXECUTING`, `WAITING`, `BLOCKED`, `RECOVERY_REQUIRED`, and `DONE` remain projections over durable facts plus current authoritative observation.

Git implements the same contract as a reference backend and independent replay oracle. Git commit IDs and SQLite commit IDs are backend-local authority revisions; neither is semantic obligation identity. Existing history is not assumed to be byte-portable between backends: facts such as claim ancestry and settlement-receipt semantic dependencies may intentionally contain those backend-local identities, so migration requires an explicit remapping proof.

## 1. Immutable project intent

A project graph should describe what must be true, not merely remember what a worker once did.

The Bazel/Nix research motivates an obligation-oriented model:

```text
task model:
  "run X and remember that it completed"

obligation model:
  "for these exact inputs, prove predicate P"
```

An obligation should eventually be identifiable from all semantically relevant inputs, including where applicable:

- graph/project revision;
- source revision;
- prerequisite realization identities;
- policy/verifier version;
- requested external effect coordinate;
- expected postcondition;
- material configuration.

This gives Overcenter a stable unit for verification and reuse.

### Design rule

> If changing a value could change whether a result is acceptable, that value belongs in the obligation's semantic identity or declared dependencies.

Ambient hidden inputs undermine both reuse and verification.

## 2. Realizations

A **realization** is a concrete candidate that may satisfy an obligation.

Examples:

- a Git tree or commit;
- generated code;
- a deployed resource;
- a GitHub status;
- a report;
- an artifact digest;
- an externally visible provider state.

The realization is not automatically project truth merely because a worker produced it.

```text
obligation
    |
producer
    |
candidate realization
    |
verification
    |
satisfied or not
```

A realization can outlive the worker that produced it.

## 3. Derivation and reuse

The derivation layer answers mechanically knowable questions before spending reasoning/execution effort.

Examples:

- Are all prerequisites satisfied?
- Is the graph structurally valid?
- Does a verified realization for the exact obligation already exist?
- Did an upstream identity change invalidate a prior realization?
- Are two candidate effects independent, commuting, or conflicting?
- Is the obligation blocked by graph structure rather than execution failure?

This is where build-system prior art matters most.

### Reuse principle

> Reuse should be keyed by semantic identity and evidence, not by trust in a previous worker session.

A human-created artifact and an agent-created artifact should be equally reusable if they satisfy the same exact predicate with acceptable evidence.

External mutations are a harder case. A provider effect is not a generic cache entry; reuse still requires authoritative observation and effect-specific semantics.

### Project projection contract

The reference implementation has one production projection boundary:

```text
validated authority history
  current obligation definitions
  historical runs
  projected receipts
  exact revision
        +
recomputed semantic judgments
  current semantic obligation identity
  current realization admissibility
        |
        v
deriveProjectProjection(...)
        |
        +--> semantic keys
        +--> realization / lifecycle relations
        +--> claimability reasons
        +--> public work state
        +--> next ready work
```

No stored `READY`, `BLOCKED`, `EXECUTING`, `WAITING`,
`RECOVERY_REQUIRED`, or `DONE` value is authoritative.

The semantic obligation key is part of the projection. Therefore public
`READY` means not only that dependencies are satisfied, but that the exact
claim identity is derivable now. Claim execution consumes that projected key
rather than performing a second semantic-identity decision afterward.

Historical settlement is also insufficient by itself for mutable-state reuse.
The production boundary separates **historical replay** from **current project
truth**:

```text
durable facts
    |
    v
historical replay
    |                     fresh authoritative observation
    |                                  |
    |                                  v
    |                     current realization judgment
    |                     admissible / rejected / indeterminate
    |                                  |
    +----------------+-----------------+
                     |
                     v
             current project projection
```

Pure replay performs no provider I/O and preserves what the durable history
proved at settlement time. Current project reads, frontier selection,
explanations, and new claims may overlay fresh realization judgments.

For run/receipt-derived mutable realizations:

- **admissible** means current authoritative evidence still proves the exact
  postcondition, so the historical realization remains `DONE`;
- **rejected** means current authoritative evidence disproves it (including
  certified absence where the verifier supports authoritative negative
  evidence), so the historical `DONE` no longer satisfies current truth;
- **indeterminate** means current evidence cannot safely decide either way, so
  the obligation is `BLOCKED` rather than silently reused or replayed.

This relation is derived, not stored. No invalidation event, stale bit, or
lifecycle repair write is required. If mutable reality drifts away and later
returns, the same exact historical settlement can disappear from and reappear
in current project truth without a new settlement.

Already-issued execution/recovery authority deliberately uses historical
projection rather than the fresh read overlay. A transient provider read cannot
revoke an execution permit; fresh current evidence instead governs whether old
settlement evidence may satisfy **new** project reads or claims.

Content-addressed immutable realization facts are a distinct case: exact
immutable identity can itself be current admissibility evidence. Their
producer-independent integration is kept separate from this mutable-state
boundary rather than forcing every reusable artifact through provider readback.

Soufflé Datalog is retained as an independent executable oracle for this
boundary. It is not a runtime dependency. The production projector remains
TypeScript unless a later experiment earns a different implementation.

### Explanations are projection too

The projector also derives structured explanations for every public work state.
These explanations are not receipts, lifecycle facts, or another authority
layer. They are disposable provenance over the same inputs used to derive
status.

```text
facts + current semantic judgments
             |
             v
     project state
             +
     explanation relation
             |
             +--> BLOCKED: exact unsatisfied dependencies
             +--> EXECUTING: exact active run
             +--> WAITING / RECOVERY_REQUIRED: exact receipt
             +--> DONE: exact accepted realization + admissibility basis
             +--> READY: exact semantic key, including release/reuse rejection
```

An explanation may refer to another obligation. Consumers can recursively
follow those obligation references through the same explanation map to render a
tree without persisting a second diagnostic graph.

Explanation materialization must be safely deletable. Fresh replay from durable
facts and current semantic judgments must reproduce the same explanation bytes
as well as the same project state.

## 4. The narrow authority kernel

Most historical facts can accumulate monotonically. A small set of questions cannot.

The non-monotonic kernel owns facts such as:

- which graph/source revision is current;
- who is currently authorized to cross a mutation boundary;
- the current fencing epoch;
- whether an external mutation is unresolved;
- whether a conflicting effect reservation already exists;
- whether an exact-current precondition still holds;
- whether a settlement CAS still targets the expected authority revision.

This is the synchronization core.

```text
mostly monotonic world
  observations
  receipts
  verification facts
  completed realizations
        |
        v
+----------------------------+
| small coordination kernel  |
| current / exclusive / none |
+----------------------------+
        |
        v
new monotonic fact
```

The CALM-derived rule is:

> Do not coordinate facts whose truth only grows. Coordinate where later information can invalidate a decision.

## 5. Execution authority and state identity are different

The distributed-fencing research separates two dimensions:

```text
execution authority
  = is this worker / lease generation still authorized?

exact state identity
  = is this still the exact project revision this action depends on?
```

Both must hold at an authoritative mutation boundary.

| Fence | Exact revision | Result |
| --- | --- | --- |
| current | current | mutation may be eligible |
| stale | current | reject stale worker |
| current | stale | reject stale state |
| stale | stale | reject both |

A Git SHA alone cannot fence a stale worker if lease ownership changes without moving Git.

A lease alone cannot protect against repository drift.

## 6. Disposable execution

Workers are deliberately treated as replaceable.

A worker may contain:

- an agent process;
- a checkout;
- local refs;
- a local database;
- caches;
- temporary generated files;
- logs;
- process memory.

None of those are authoritative merely because they are convenient.

The strongest trust-boundary experiment deliberately lets an executor corrupt its own:

- checkout;
- local Git configuration;
- local Overcenter state ref;
- local kernel source;
- cache.

The stronger reference boundary does not give the disposable worker provider-mutation authority at all. In GitHub Actions, the worker job has repository read permission only. A separate trusted effect-broker job owns provider write permission and the execution permit.

### Worker contract

Conceptually:

```text
worker(snapshot)
    -> candidate effect intent / candidate realization / execution evidence
```

The worker does not need:

```text
ExecutionPermit
provider write credential
reservation authority
settlement authority
```

Those belong to deterministic trusted machinery.

```text
worker
  candidate intent
      |
      v
trusted effect broker
  validate against authoritative obligation
  acquire current execution authority
  reserve
  mutate provider
      |
      v
authoritative observation / settlement
```

not:

```text
worker(...)
    -> authoritative project truth
```

## 7. External effects

An external effect crosses from Overcenter-controlled state into another authoritative system.

Examples:

- create/update a GitHub object;
- deploy a service;
- send a provider request;
- update a cloud resource;
- write an external database;
- publish a message.

The provider may not share a transaction with Overcenter.

In the core loop, non-effectful judgment is separated from provider mutation. A preflight callback may choose `judgment-required` without receiving the execution permit. If execution proceeds, the kernel validates that permit and commits the durable effect reservation before invoking the trusted effect handler. The handler receives the work packet, not the execution permit. Once that boundary is crossed, a late judgment result cannot downgrade the attempt to ordinary `WAITING`; it must be reconciled as potentially mutating.

That creates the fundamental uncertainty window:

```text
authorize
   |
preflight judgment
   |
reserve effect
   |
provider effect
   |
   X response lost
   |
unknown outcome
```

The architecture must not collapse this into an ordinary retry error.

## 8. Mutation certainty

Overcenter separates **external truth** from **knowledge about external truth**.

A useful minimum knowledge domain is:

```text
present
absent
uncertain
```

where:

- **present** means authoritative evidence establishes the material effect exists;
- **absent** means the provider contract makes the negative observation authoritative enough to permit replay;
- **uncertain** means neither conclusion is justified.

This is not merely a UI state.

It controls whether another effect attempt is safe.

### Replay rule

```text
present
  -> do not replay
  -> verify desired predicate
  -> settle if acceptable

absent
  -> retry may become eligible after fresh authority validation

uncertain
  -> do not replay
  -> keep recovering / observing / escalate
```

A timeout is never evidence of absence.

A 404 is only evidence of absence when the provider's consistency model makes it so.

### Absence evidence is a certificate

`absent` is a derived knowledge classification, not sufficient evidence by itself.

New receipt semantics require a provenance-bearing absence certificate with this generic envelope:

```text
subject       exact coordinate claimed absent
scope         authority boundary searched
snapshot      provider state identity, when applicable
completeness  why non-membership proves absence
provenance    how the evidence was obtained / certified
```

The envelope does not make arbitrary provider claims trustworthy. Provider-specific verifier code still decides whether a certificate kind and its contents prove authoritative absence.

The current local-file certificate is deliberately small:

```text
kind          local-file-enoent/v1
subject       exact file path
scope         direct exact-coordinate read
snapshot      none
completeness  ENOENT from that direct read
provenance    node:fs readFileSync / ENOENT
```

The Kubernetes experiment fits the same envelope without weakening its stronger semantics:

```text
kind          kubernetes-complete-list-absence/v1
subject       group/resource/namespace/name
scope         collection group/resource/namespace
snapshot      collection resourceVersion
completeness  exact continuation chain to terminal page
provenance    provider contract + structural page certificates
```

A partial LIST, broken continuation chain, or broken WATCH continuity cannot mint that certificate.

Durable receipts use the current receipt-v5 observation vocabulary at this boundary. A negative observation can settle back to READY only when it carries verifier-accepted authoritative absence evidence.

## 9. Observation

An **observation** is a read of an authoritative system at a named coordinate.

Good observations name enough identity to make their meaning precise.

Examples:

```text
Git ref:
  remote authority
  exact ref
  observed target SHA

GitHub status:
  numeric repository identity
  exact commit SHA
  normalized context
  observed status state
```

Observations should not silently depend on mutable sandbox aliases when a canonical provider identity is available.

Observation and verification are separate:

```text
observation:
  "provider says X"

verification:
  "X proves predicate P for obligation O at revision R"
```

## 10. Verification

Verification is a deterministic predicate over:

- the obligation;
- exact identity/revision;
- provider/artifact observation;
- verifier semantics.

The executor should not be allowed to substitute a new verifier at settlement time.

This yields the kernel rule:

> A producer cannot define the acceptance test for its own result after execution.

Verification evidence should name the exact coordinate it proves.

Evidence for revision A cannot settle revision B merely because the data looks similar.

## 11. Settlement

**Settlement** is the authoritative project-state commit boundary.

A safe settlement conceptually rechecks:

```text
current execution authority
AND
exact project revision
AND
acceptable mutation certainty
AND
exact verification evidence
AND
no conflicting terminal settlement
```

then performs a compare-and-swap against project authority.

Settlement is deliberately later than execution.

```text
execution success
    !=
settlement

verification success
    !=
settlement

candidate integration
    !=
settlement

settlement
    =
authoritative acceptance of exact evidence
```

A lost acknowledgement after successful settlement should be resolved idempotently from durable state rather than creating a second semantic terminal result.

## 12. Durable evidence

The evidence model follows the principle:

> Preserve proofs, not exhaust.

Correctness-critical durable evidence should be enough to justify terminal project truth after ordinary execution machinery disappears.

That can include:

- obligation identity;
- exact input/source/graph revision;
- authorization/fencing identity;
- material effect identity;
- authoritative observations;
- verification result and verifier version;
- settlement identity;
- resulting project-state digest;
- amendment ancestry where relevant.

Ordinary scheduler wakes, retries, heartbeats, duplicate responses, and temporary logs are usually execution telemetry rather than permanent project truth.

The transition-attestation research proposes an eventual compact envelope for this information.

## 13. Project state is a projection

Statuses such as `READY` and `DONE` are useful operator surfaces.

They should not be confused with the deepest historical truth.

The implementation distinguishes **realization state** from these operator states. An obligation with no currently valid realization or active run is internally `UNREALIZED`. Only deterministic eligibility may project `UNREALIZED` to public `READY` or `BLOCKED`. This prevents "not yet realized" from being confused with "safe to execute now."

Before an obligation can enter authoritative history, graph admission now rejects facts that are already mechanically known to be unsafe or meaningless:

- unsupported semantic selectors;
- semantic outputs the upstream verifier cannot identify;
- missing settlement semantics for the verifier;
- unknown dependencies and cycles;
- statically known unordered incompatible effect coordinates.

For newly admitted work, definition or amendment failure therefore happens before the authority CAS. Existing v3 fact history is replayed under its original durable syntax semantics; defensive eligibility still fails closed on a legacy static effect conflict instead of retroactively making old authority unreplayable.

Settlement authority is also declared before execution begins. Replay from absence requires both:
- verifier-level semantics that permit authoritative negative evidence; and
- observation-specific evidence that this read actually established authoritative absence.

A generic `mutation_certainty: "absent"` field alone never reopens execution under receipt v5. The verifier must accept the concrete absence-certificate kind, and provider-specific validation must bind its subject, scope, completeness, snapshot, and provenance as required.

### READY

An obligation is READY when:

- its structural prerequisites are satisfied;
- no dynamic eligibility condition blocks it;
- no valid existing realization already satisfies it;
- no unresolved prior mutation forbids replay;
- current authority permits a new attempt.

### EXECUTING

A currently authorized run exists and has not yet reached a durable non-executing disposition.

### WAITING

The work is intentionally suspended on a known external condition, human decision, timer, or dependency that does not imply mutation uncertainty.

### BLOCKED

Deterministic structure or policy says execution cannot safely proceed.

Examples:

- unsatisfied dependencies;
- a dynamic execution precondition is not currently met.

For newly admitted work, invalid graph/amendment structure and statically knowable effect conflicts are earlier admission failures. Defensive projection may still surface a legacy static conflict as `BLOCKED` so older v3 authority remains replayable without becoming executable.

### RECOVERY_REQUIRED

A prior attempt cannot safely be treated as success or absence.

Typical causes:

- provider outcome may have mutated;
- provider readback is incomplete or conflicting;
- an exact authoritative observation is unavailable;
- recovery must reconcile an interrupted run.

### DONE

DONE should be understood semantically as:

```text
valid terminal settlement exists
AND
required effect / realization is established
AND
verification binds exact obligation/revision
AND
durable evidence remains sufficient
```

A product may cache a DONE label.

The architectural truth is the predicate over evidence.

## 14. Graph semantics

The current graph is intentionally simpler than a general workflow language.

Its base semantics are:

- finite directed acyclic dependency graph;
- `requires` is AND semantics;
- roots can be enabled independently;
- fan-out is AND-split;
- fan-in is AND-join;
- concurrency comes from absence of causal dependency;
- completed facts grow monotonically.

Do not infer XOR or OR semantics from topology.

If alternative-path semantics are ever added, they should be explicit constructs with explicit correctness rules.

## 15. Effect ordering and concurrency

Project-authority updates may serialize through one CAS coordinate without forcing external effects themselves to execute serially.

The prototype demonstrates:

- independent obligations can remain `EXECUTING` simultaneously;
- independent recovery processes can settle through one authority ref;
- exact claim identity survives later authority movement.

For the canonical GitHub commit-status adapter, effect semantics currently identify a resource by:

```text
repository identity
+ exact commit
+ normalized status context
```

Two effects on that coordinate:

- may commute when their desired state is explicitly identical;
- must be ordered when desired states conflict;
- otherwise become `BLOCKED` rather than racing.

This is adapter-specific.

A verifier that cannot define a canonical mutation coordinate must not pretend to provide generic conflict semantics.

## 16. Amendments are workflow-state migration

Changing the graph after work has completed is not merely editing configuration.

An amendment must preserve causal validity of already-established project truth.

A useful minimum rule from the Petri-net/workflow analysis is:

> The completed set must remain predecessor-closed under the amended graph.

An amendment must not retroactively declare that a completed transition depended on something that was not complete when that transition became valid, unless a deliberate migration/revalidation protocol supplies new evidence.

Graph revision identity therefore belongs in completion evidence.

## 17. Formal kernel boundary

The transaction/recovery kernel is small enough to model independently of the whole product.

The useful state dimensions are:

- current owner;
- lease/fence;
- exact revision;
- unresolved mutation reservation;
- external effect truth;
- mutation knowledge;
- verification identity;
- settlement;
- durable terminal evidence.

The model should prove safety properties such as:

- stale authority cannot cross a mutation/settlement boundary;
- evidence cannot cross exact revisions;
- uncertainty cannot enable blind replay;
- conflicting successor effects cannot overlap an unresolved authoritative mutation;
- DONE cannot exist without valid evidence.

It should **not** try to prove that every project eventually completes or that providers are correct.

## 18. Architectural source map

The research notes are best read as bounded prior-art lenses feeding this one model.

| Research note | Architectural contribution |
| --- | --- |
| [Bazel / Nix graph derivation](research/bazel-nix-graph-derivation.md) | Immutable obligations, realizations, exact reuse identity, incremental re-evaluation |
| [CALM / monotonic state](research/calm-monotonic-state.md) | Mostly monotonic proof graph around a tiny non-monotonic coordination kernel |
| [Distributed fencing](research/distributed-fencing.md) | Separate execution-generation fencing from exact repository identity |
| [FoundationDB transaction semantics](research/foundationdb-transaction-semantics.md) | Observe/speculate/validate/commit; distinguish conflict from unknown commit outcome |
| [Git transaction substrate](research/git-transaction-substrate.md) | Immutable objects plus ref CAS as a minimal durable authority experiment |
| [Kubernetes / Flux reconciliation](research/kubernetes-flux-reconciliation-prior-art.md) | Desired/observed state, reconciliation loops, generations, status as observation rather than intent |
| [Petri nets / workflow correctness](research/petri-nets-workflow-correctness.md) | Partial-order concurrency, graph soundness, amendment-as-state-migration |
| [TLA+ formal kernel](research/tla-formal-kernel.md) | Minimal transaction/recovery state machine and safety invariants |
| [Transition attestations](research/transition-attestations.md) | Compact durable proof, evidence retention, authority/provenance identity |

The notes remain useful for detailed prior art. This file is the canonical cross-note architecture.

## Glossary

| Term | Meaning |
| --- | --- |
| **Authority revision** | Exact backend-local revision currently allowed to define project truth. Production uses a SQLite fact-commit ID named by the authority row; the Git reference backend uses a commit reachable from its authority ref. |
| **Claim** | Durable reservation of one obligation for an execution attempt at an exact authority revision. |
| **Completion certificate** | Durable evidence sufficient to derive that an obligation is satisfied for a particular graph/revision. Conceptual target; not merely a worker success flag. |
| **Effect coordinate** | Canonical identity of the external resource/location an operation can mutate. Used to reason about conflicts, commutativity, and readback. |
| **Effect identity** | Identity of a particular requested or observed external effect, including the material coordinate and desired state. |
| **Evidence** | Durable fact used to justify verification, settlement, provenance, or recovery. |
| **Execution authority** | Permission for a particular worker/lease generation to cross an authoritative mutation boundary. |
| **Fence / fencing epoch** | Monotonically increasing generation used to reject stale execution authority even if project state itself did not change. |
| **Graph revision** | Immutable identity of one project-obligation graph definition. |
| **Mutation certainty** | Knowledge classification of an external effect: present, authoritatively absent, or uncertain. |
| **Obligation** | Immutable predicate describing what must be true for exact inputs and acceptance semantics. |
| **Obligation identity / key** | Semantic identity derived from all inputs that determine whether a realization is acceptable. |
| **Observation** | Read of authoritative external/project state at a named exact coordinate. |
| **Postcondition** | Predicate that must hold in authoritative reality for a candidate effect/realization to satisfy an obligation. |
| **Projection** | Current computed view such as READY/DONE/BLOCKED over durable facts plus current authority. |
| **Provider adapter** | Deterministic software that knows how to identify an external effect, read authoritative state, classify negative evidence, and verify a provider-specific postcondition. |
| **Realization** | Concrete artifact or external state that may satisfy an obligation. |
| **Recovery** | Deterministic continuation from durable facts after execution loss or uncertain mutation outcome. Recovery is not a reset. |
| **Replay** | Re-attempt of effectful work. After an uncertain mutation, replay requires authoritative evidence that repetition is safe. |
| **Receipt** | Durable record of a claim/defer/recovery/settlement decision and its material evidence. |
| **Reuse** | Accepting an existing realization for an exact obligation instead of running a new producer. |
| **Run** | One execution attempt associated with a claimed obligation. Run identity is not obligation identity. |
| **Settlement** | Authoritative acceptance of verified evidence into project truth, normally fenced and exact-revision checked. |
| **Transition attestation** | Proposed compact long-term certificate describing exact intent, effects, verification, authority, and resulting state. |
| **Unresolved mutation reservation** | Durable fact that an already-authorized effect may still exist and conflicting successor effects must not be issued until resolved. |
| **Verification** | Deterministic decision that an observation/realization proves the exact obligation predicate. |
| **Worker / agent** | Disposable producer of candidate work. It is not automatically an authority on settlement. |

## Architectural test

When adding machinery, ask:

> Is this a judgment that requires reasoning, or mechanically knowable execution correctness?

Prefer:

```text
reasoning agents
    -> judgment, synthesis, ambiguous design choices

deterministic software
    -> identity, fencing, CAS, validation, counting,
       reconciliation, conflict detection, evidence binding,
       recovery state derivation, projection
```

The architecture gets stronger as routine correctness migrates out of prompts and into semantic software boundaries.
