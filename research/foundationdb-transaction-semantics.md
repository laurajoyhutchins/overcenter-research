# FoundationDB Transaction Semantics as Prior Art for Overcenter

## Scope

This note studies FoundationDB's transaction model as prior art for Overcenter, with emphasis on:

- optimistic concurrency control;
- read and write conflict ranges;
- commit-time validation;
- exact-revision assumptions;
- retry behavior;
- unknown commit outcomes;
- the separation between speculative execution and authoritative commit.

It then maps those concepts onto Overcenter's current `project.inspect`, `project.advance`, exact-head verification, project-transition leases, settlement, mutation-certainty, and recovery mechanisms.

The purpose is architectural research only. It does not propose or implement code changes in this repository.

## Executive conclusion

FoundationDB is unusually relevant prior art for Overcenter because its central abstraction is not merely "transactions." It is a disciplined separation between:

1. observing a stable snapshot;
2. performing useful work optimistically;
3. recording what that work depended on;
4. validating those dependencies at a narrow commit boundary; and
5. allowing authoritative state to change only after successful validation.

That pattern fits Overcenter closely:

```text
OBSERVE        EXECUTE              VALIDATE              COMMIT
snapshot  ->   speculative work  -> dependency checks  -> settlement receipt
   |                                    |
   |                                    +-- conflict -> retry / reconcile
   +-- exact inputs                         unknown -> recover, never guess
```

In Overcenter terms:

```text
project.inspect
      |
      v
authoritative observation
      |
      v
project.advance
lease / derive / execute
      |
      v
settlement validation
  |- authority still valid?
  |- dependencies still valid?
  |- lease/fence still valid?
  |- mutation outcome known?
  `- evidence attributable?
      |
      v
atomic Overcenter settlement + durable receipt
```

Overcenter already contains many of these pieces. Its exact Git revision checks, graph and transition fingerprints, lease authority, atomic lease settlement, mutation-certainty model, and stale-authority reconciliation are all recognizable parts of an optimistic transaction system.

The main architectural opportunity is therefore not "add transactions." It is:

> Make Overcenter's existing authority revision, semantic fingerprints, lease fence, evidence, mutation certainty, and settlement receipt one explicit transaction contract.

The most valuable FoundationDB idea to steal is **first-class conflict/dependency tracking**. Overcenter should validate the exact semantic facts an execution relied upon, rather than treating any movement of the global repository revision as inherently invalidating.

At the same time, Overcenter should retain stronger exact-revision fencing where identity itself matters. Exact Git revision and semantic conflict sets solve different problems.

---

## 1. FoundationDB transaction model

FoundationDB provides strictly serializable transactions using multi-version concurrency control and optimistic concurrency control. A transaction reads from a stable snapshot and accumulates mutations locally. It does not acquire locks for ordinary reads and writes. At commit, FoundationDB validates whether conflicting transactions committed since the transaction's read version. If so, the transaction is rejected and normally retried.

The important conceptual lifecycle is:

```text
obtain read version
      |
read stable snapshot
      |
perform speculative reads/writes
      |
construct conflict information
      |
commit request
      |
resolver validates conflicts
      |
  +---+---+
  |       |
valid   conflict
  |       |
log      retry from new snapshot
mutations
  |
durable commit
```

FoundationDB distinguishes three important things:

- the snapshot a transaction observed;
- the set of facts whose values matter to correctness;
- the writes the transaction proposes to make.

That is more precise than simply invalidating a transaction whenever anything anywhere has changed.

### Sources

Primary FoundationDB references:

- FoundationDB Developer Guide: https://apple.github.io/foundationdb/developer-guide.html
- FoundationDB Architecture: https://apple.github.io/foundationdb/architecture.html
- FoundationDB paper, *FoundationDB: A Distributed Unbundled Transactional Key Value Store*: https://www.foundationdb.org/files/fdb-paper.pdf

---

## 2. Mapping FoundationDB concepts to Overcenter

| FoundationDB concept | Overcenter analogue | Assessment |
| --- | --- | --- |
| Read version / MVCC snapshot | GitHub `authority_revision` returned by `project.inspect` | Strong analogy |
| Transaction body | `project.advance` derivation plus agent/executor work | Similar, but external effects make blind replay unsafe |
| Read conflict ranges | Semantic facts/fingerprints execution relied upon | Partially implemented |
| Write conflict ranges | Transition/run/lease/settlement state being changed | Mostly implicit |
| Commit validation | Lease/current-authority validation immediately before settlement | Already strongly analogous |
| Commit result | Durable settlement and operation receipts | Present, but not yet one unified abstraction |
| Transaction conflict | `PROJECT_TRANSITION_AUTHORITY_STALE`, lease/fingerprint invalidation | Strong analogy |
| Retry loop | requeue -> inspect/advance again | Correct for replay-safe computation, not automatically for external effects |
| `commit_unknown_result` | `may_have_mutated`, indeterminate operation | Extremely strong analogy |
| Resolver | transition reconciliation / settlement validator | Concept exists but is distributed across modules |

---

## 3. `project.inspect` should be understood as a read-version operation

The current Overcenter `project.inspect` path is already well aligned with the idea of a transaction snapshot.

Relevant implementation paths in the current Overcenter codebase include:

- `mcp/project.inspect.js`
- `lib/project-inspect-github-runtime.js`
- `lib/project-inspect-overcenter-host.js`

`project.inspect` reads the authoritative repository-owned project graph, requires an exact 40-character Git revision, evaluates the project horizon, and returns the authoritative revision together with completion/frontier information.

Conceptually:

```text
project.inspect
   -> authority_revision
   -> complete
   -> frontier
   -> frontier_details
```

The FoundationDB lesson is that this result is an **observation**, not an authorization.

A result saying transition `T` is currently READY does not reserve `T`, nor does it guarantee that the same assumptions are still true when work later attempts to settle. The execution path must obtain its own current authority and validate the assumptions that make its result safe.

### Recommendation: formalize an observation identity

Internally, Overcenter could represent an inspection as something like:

```text
project_observation
  project_ref
  authority_repository
  authority_revision
  authority_derivation
  graph_fingerprint
  observed_at
```

This should not become manual bookkeeping agents have to shuttle around on the normal happy path. It is useful because it gives execution records and receipts a precise answer to:

> What authoritative project reality was this judgment based on?

The exact authority revision already exists. The architectural improvement is to make the observation itself a named concept.

---

## 4. Conflict ranges are the strongest idea to import

FoundationDB does not reject a transaction merely because *something* changed after the transaction started. It validates whether relevant writes intersect the transaction's read-conflict set.

That idea matters for Overcenter because Git provides a very coarse global signal: a branch or repository head changed. Yet many such changes are semantically unrelated to an in-flight transition.

Overcenter already has the beginnings of a more precise model.

Current project-transition lease/reconciliation code records and compares facts such as:

- authority revision;
- graph fingerprint;
- transition definition fingerprint;
- transition revision fingerprint;
- transition dependency fingerprint;
- authority derivation;
- unique lease ownership / authority epoch.

Relevant paths include:

- `lib/project-transition-leases.js`
- `lib/project-transition-revision-fingerprint.js`
- `lib/project-transition-dependency-fingerprint.js`
- `lib/project-graph-reconciliation.js`

When the global graph revision changes, current logic does not blindly invalidate every lease. It can compare the in-flight transition's definition and dependency fingerprints and decide whether existing execution authority may safely continue.

That is already a **semantic conflict model**.

### The important next step

Current fingerprints primarily answer questions such as:

- Did the transition definition change?
- Did the list of dependencies change?

FoundationDB suggests a stronger formulation:

> Record the exact authoritative values of the facts that influenced the decision.

For example:

```text
READ SET
  transition T definition          = fingerprint abc
  transition T dependency schema   = fingerprint def
  predecessor A confirmation       = receipt sha 111
  predecessor B confirmation       = receipt sha 222
  source branch head               = commit 333
  required-check policy            = fingerprint 444
  required check result            = receipt 555

WRITE SET
  transition T confirmation
  run R settlement
  lease L release
  evidence receipt E
```

Then commit-time validation asks:

> Did any authoritative fact this execution actually depended on change?

This is much better than:

> Did the repository head change?

### Recommendation: introduce a semantic validation/read set

A small internal abstraction could unify this:

```text
transition_validation_set
  facts[]
    key
    observed_value
    validation_mode
```

Semantic keys could look like:

```text
project-transition-definition:T
project-transition-confirmation:A
github-ref:owner/repo:branch
required-check-policy:owner/repo
deployment-target:production
artifact:build-123
```

The implementation does not need literal FoundationDB key ranges. Semantic facts are the right unit for Overcenter.

---

## 5. Exact revision is not the same as conflict validation

A FoundationDB read version and a Git commit SHA are related ideas, but they are not interchangeable.

An FDB read version identifies a database snapshot. Conflict information determines which subsequent changes matter to the transaction.

A Git commit SHA identifies exact immutable repository content and history. For many Overcenter operations, this exact identity is part of the object being acted on.

Current exact-revision verification correctly requires that:

- the requested repository/revision resolves exactly;
- verification executes against that revision; and
- returned evidence is attributable to that exact revision.

Relevant path:

- `lib/exact-revision-verification.js`

That should remain strong.

Operations such as these should normally remain exact-revision fenced:

```text
verify this exact commit
apply a patch against this exact tree
merge the exact reviewed PR head
promote this exact artifact
attest that tests passed for this exact revision
```

FoundationDB's lesson is **not** that head movement should be ignored. It is that unrelated movement should not invalidate work when the exact moving head is not itself a semantic dependency.

A useful rule is:

> **Exact revision is an identity constraint. A validation/read set is a dependency constraint. Never substitute one for the other.**

---

## 6. `project.advance` is closer to a transaction runner than to a commit

Relevant current paths include:

- `mcp/project.advance.js`
- `lib/project-advance-overcenter-host.js`
- orchestration run/advance/finish services invoked beneath it.

`project.advance` creates or resumes a durable run, obtains/maintains execution authority, advances deterministic machinery, may return work requiring judgment or execution, accepts an execution result, and routes completion into settlement before continuing the project.

FoundationDB terminology clarifies what this should mean conceptually.

`project.advance` is closest to:

```text
run(transaction_function)
```

not simply:

```text
commit()
```

A reasoning agent may return something such as:

```text
disposition: completed
evidence: [...]
```

That should mean:

> Here is the proposed result of speculative execution.

It should **not** by itself mean:

> This transition is now authoritative project truth.

Only deterministic settlement, after revalidation, should establish that.

This is a particularly clean expression of Overcenter's core design principle:

> Reasoning agents should make judgments; deterministic software should own execution correctness.

---

## 7. Settlement is Overcenter's commit boundary

FoundationDB keeps writes speculative until commit. At commit time, conflict information is validated, a commit version is assigned, mutations are written durably, and success is returned only after the database has established the authoritative outcome.

Overcenter's project-transition settlement is already close in spirit.

Current settlement logic:

- supports idempotent replay of the same settlement request;
- requires atomic lease-and-slot storage;
- revalidates the current lease before settlement;
- carries authority epoch/revision and graph/transition fingerprints;
- atomically records local settlement state.

Relevant paths include:

- `lib/project-transition-leases.js`
- `lib/project-transition-lease-store.js`
- `lib/project-transition-stale-reconciliation.js`

This suggests a crisp architectural rule:

> **Settlement is the only authoritative commit boundary for a project transition.**

Everything before settlement is observation, proposed execution, external effect evidence, or provisional state.

### Where the analogy stops

FoundationDB owns all database writes participating in its transaction protocol. Overcenter does not own a single transactional substrate for:

- GitHub refs and pull requests;
- CI results;
- Linear state;
- hosting/deployment state;
- arbitrary future providers;
- local Postgres state.

Therefore Overcenter cannot honestly provide one ACID transaction spanning all of them.

The achievable design is instead:

```text
        external world
             |
   idempotent/observable effect
             |
             v
       durable evidence
             |
             v
    +-----------------------+
    | OVERCENTER COMMIT     |
    | validate assumptions  |
    | settle local truth    |
    | store receipt         |
    +-----------------------+
```

Overcenter can make **its own authoritative project-state transition** transactional. External effects must be handled through operation-specific recovery semantics such as idempotence, confirmation, compensation, or reconciliation.

That is stronger and more honest than pretending distributed ACID exists.

---

## 8. Retry semantics: retry computation, not necessarily effects

FoundationDB's normal conflict-handling model is to reset and rerun a transaction body from a fresh snapshot.

That is safe because the transactional reads/writes are controlled by FoundationDB. The FoundationDB documentation warns that non-transactional side effects performed by application code are not rolled back merely because the FDB transaction is retried.

This maps directly onto autonomous software execution.

### Replay-safe computation

These steps are generally safe to repeat:

```text
read current project graph
derive frontier
evaluate deterministic readiness
recompute a plan
select a deterministic continuation
```

### Potentially unsafe external effects

These may not be safe to blindly repeat:

```text
push commit
open pull request
merge pull request
change provider state
publish release
deploy service
send external notification
```

Therefore Overcenter retry semantics should be phase-aware:

```text
before external effect
    conflict -> fresh observation + rederive

external effect proven not to have happened
    retry operation

external effect proven to have happened
    resume at confirmation / settlement

external effect may have happened
    reconcile first

settlement conflict after successful external effect
    revalidate / reconcile
    do NOT blindly repeat the external effect
```

This supports the existing direction of moving deterministic execution bookkeeping out of prompts and into software.

### Recommendation: distinguish retryable computation from retryable effects

A generic `retryable: true` flag is often too weak.

Mutation contracts should declare recovery semantics explicitly, for example:

```text
pure_recompute
idempotent_retry
confirm_then_continue
reconcile_before_retry
compensate_then_retry
operator_required
```

The generic orchestration kernel should consume those declarations rather than infer safety from error shape.

---

## 9. `commit_unknown_result` is a direct analogy for mutation uncertainty

One of FoundationDB's most useful distributed-systems lessons is `commit_unknown_result`.

A client can lose contact after sending a commit and therefore not know whether the commit succeeded. Retrying blindly can duplicate an application-level operation unless the application uses a stable transaction identity or another idempotence mechanism.

Overcenter already has almost exactly this problem and vocabulary.

Relevant current machinery includes:

- operation IDs;
- idempotency keys;
- `may_have_mutated`;
- mutation certainty (`none`, `possible`, `confirmed`);
- indeterminate operations;
- durable operation state;
- reconciliation/recovery flows.

Relevant paths include:

- `lib/mutation-certainty.js`
- orchestration journal/operation-state code;
- `lib/orchestration-recovery.js`

The conceptual translation is:

```text
FoundationDB transaction identity
        ->
Overcenter operation_id / idempotency_key

FoundationDB unique transaction effect
        ->
provider-side effect identity / durable receipt

commit_unknown_result
        ->
may_have_mutated:true / indeterminate operation

retry
        ->
reconcile receipt/provider state first
```

### Recommendation: make commit outcome a first-class kernel state

The existing richer mutation-certainty vocabulary is useful, but underneath it the kernel needs a very crisp invariant:

```text
DEFINITELY_NOT_COMMITTED
COMMITTED
COMMIT_OUTCOME_UNKNOWN
```

The recovery consequences are mechanical:

```text
DEFINITELY_NOT_COMMITTED
    -> operation may be attempted if other authority is valid

COMMITTED
    -> do not repeat; continue with confirmation/settlement

COMMIT_OUTCOME_UNKNOWN
    -> reconcile before any further mutation
```

This reframes `may_have_mutated:true` as a distributed commit-outcome problem, not merely an error flag.

---

## 10. Stale-authority reconciliation is already an embryonic resolver

Current Overcenter stale-authority and graph-reconciliation code does more than exact-head checking.

Conceptually, it performs logic similar to:

```text
authority changed
      |
      v
transition still present?
      |
definition same?
      |
dependencies same?
      |
authority source still valid?
      |
unique execution authority intact?
      |
   +--+--+
   |     |
  yes    no
   |     |
continue stale/requeue
```

That resembles an optimistic transaction resolver deciding whether an observed change actually conflicts with the in-flight operation.

### Recommendation: generalize this machinery rather than replace it

The existing transition-specific reconciliation model should evolve into a general validation-set evaluator:

```text
                 today
     transition-specific reconciliation
                    |
                    v
              generalize to
                    |
                    v
        semantic validation/read set
                    |
          +---------+---------+
          |                   |
          v                   v
 transition facts       provider facts
 dependency state       Git head / checks
 definition             deployment target
 evidence               policy version
```

Then settlement becomes a generic validator of declared assumptions, while each semantic operation declares which assumptions matter.

---

## 11. Concrete architectural changes to consider

### 11.1 Formalize a first-class transition transaction envelope

Every transition attempt should internally have a durable transaction envelope containing concepts such as:

```text
transition_attempt
  attempt_id
  project_ref
  transition_id

  observation
    authority_repository
    authority_revision
    authority_derivation
    graph_fingerprint

  execution_authority
    lease_ref
    authority_epoch
    expires_at

  validation_set
    facts[]

  proposed_effects[]
  observed_effects[]
  evidence[]

  mutation_outcome
  settlement_state
  settlement_receipt
```

Agents should not manually assemble or maintain this envelope. It is deterministic orchestration state.

### 11.2 Promote fingerprints into an explicit semantic read set

The current transition revision/dependency fingerprints are valuable. Extend the same pattern to all authoritative facts that affect the transition's correctness.

Examples:

- predecessor confirmation identity;
- exact source/ref SHA;
- CI policy definition;
- CI result identity;
- target deployment environment generation;
- branch protection/ruleset identity;
- artifact digest;
- external resource version.

### 11.3 Make write intent explicit too

FoundationDB models both read and write conflict ranges.

Overcenter could make the intended authoritative changes explicit before settlement:

```text
write_set
  settle transition T as DONE
  consume lease L
  record evidence receipt E
  advance run R
```

This does not mean external effects become transactional. It makes Overcenter's own state transition explicit and auditable.

### 11.4 Make settlement the sole authoritative transition commit

Execution completion and verification evidence should remain provisional until deterministic validation succeeds.

No provider callback, agent response, CI conclusion, or local execution return should independently imply project completion.

### 11.5 Standardize unknown mutation outcome semantics

Normalize provider/runtime errors into the kernel states:

- definitely not committed;
- committed;
- commit outcome unknown.

Keep richer provider detail underneath, but make the recovery invariant universal.

### 11.6 Move validation-set construction into semantic primitives

The code that knows what it read should declare those dependencies.

Examples:

- a GitHub merge primitive knows it depends on the exact reviewed PR head and relevant merge policy;
- a deployment primitive knows the artifact digest and target environment generation;
- a transition executor knows which predecessor confirmations and graph definition controlled readiness.

Generic orchestration should not reconstruct this from logs after the fact.

### 11.7 Keep exact-SHA fencing where exact identity matters

Do not generalize optimistic continuation into permissiveness.

If the operation is "verify SHA X," then SHA X changing is not a conflict to reconcile around. It means the operation is now about a different object.

Semantic conflict sets should reduce **false invalidation**, not weaken identity guarantees.

### 11.8 Treat optimistic conflicts as normal control flow

A stale read set is not necessarily a broken run.

A first-class result could look conceptually like:

```text
ADVANCE_CONFLICTED
  invalidated_facts: [...]
  external_effect_outcome: none
  safe_continuation: rederive
```

or:

```text
ADVANCE_CONFLICTED
  invalidated_facts: [...]
  external_effect_outcome: committed
  safe_continuation: reconcile_then_settle
```

This is cleaner than treating expected concurrency as generic orchestration failure.

### 11.9 Give every authoritative settlement a durable commit receipt

The settlement receipt should bind together:

- attempt/operation identity;
- transition identity;
- lease/fence epoch;
- original observation;
- validation set and its validated values;
- external effect evidence;
- exact verification evidence;
- mutation outcome;
- resulting project transition state;
- settlement timestamp;
- any observed graph revision change that was proven non-conflicting.

This is the closest useful analogue to an FDB committed transaction/version.

It need not be one global monotonically increasing integer. A cryptographically bound receipt plus local authoritative sequence/version is sufficient unless later architectural requirements create a need for total ordering.

### 11.10 Unify existing mechanisms conceptually before adding new machinery

Overcenter already has:

- Git exact-revision authority;
- transition fingerprints;
- lease epochs/fencing;
- graph reconciliation;
- atomic local settlement;
- idempotency keys;
- operation state;
- mutation certainty;
- recovery flows;
- evidence/receipts.

The priority should be to make these **one coherent transaction model**, not to create a parallel subsystem named "transactions."

---

## 12. Recommended conceptual contract

The architecture can be summarized as one durable protocol:

```text
1. OBSERVE
   Read authoritative project state.
   Produce an exact observation identity.

2. DECLARE DEPENDENCIES
   Record the semantic facts whose observed values make the proposed work valid.

3. ACQUIRE EXECUTION AUTHORITY
   Obtain lease/fence authority for the transition.

4. EXECUTE SPECULATIVELY
   Perform deterministic computation and permitted external operations.
   Record operation identities and evidence.

5. CLASSIFY EFFECT OUTCOMES
   For every external mutation, establish:
     - definitely not committed,
     - committed, or
     - commit outcome unknown.

6. VALIDATE
   Immediately before authoritative settlement:
     - verify lease/fence authority;
     - verify exact identities where required;
     - validate semantic dependency/read set;
     - verify evidence attribution;
     - reject unresolved mutation uncertainty.

7. COMMIT
   Atomically settle Overcenter's own authoritative transition state and write a receipt.

8. RECOVER
   On conflict, rederive from fresh authority.
   On unknown external effect outcome, reconcile first.
   Never blindly replay an effect whose outcome is ambiguous.
```

This would give Overcenter a clean answer to a fundamental question:

> When an agent says it finished something, exactly what converts that probabilistic claim into project truth?

Answer:

> A deterministic transaction settlement that proves the execution still owns authority, proves the facts it relied on are still valid, proves its evidence belongs to the intended exact objects, and proves every relevant external effect has a known outcome.

---

## 13. What not to copy from FoundationDB literally

FoundationDB is a database. Overcenter is coordinating effects across systems that do not participate in one commit protocol.

Several FoundationDB ideas therefore should remain analogies rather than literal implementations.

### Do not attempt global distributed serializability across providers

Trying to make GitHub, CI, Linear, hosting, and Postgres behave like one ACID database would either be impossible or require a distributed transaction protocol that those systems do not expose.

Overcenter should instead serialize **its own project truth** and demand evidence/recovery contracts for external effects.

### Do not use one global revision as the sole concurrency token

A Git SHA is excellent exact identity but too coarse as a universal semantic conflict detector.

### Do not automatically rerun arbitrary agent execution

FDB transaction functions are designed for retry. Agent runs may perform real-world/external actions that are not rollback-safe.

### Do not make agents think in read/write ranges

This should be kernel and semantic-primitive machinery. The product-facing model should remain project transitions, readiness, judgment, execution, evidence, and completion.

---

## 14. Final architectural takeaway

FoundationDB provides a useful lens for simplifying Overcenter's correctness model:

```text
Current pieces
  exact Git revision
  graph fingerprints
  transition fingerprints
  lease + authority epoch
  idempotency keys
  operation journal
  mutation certainty
  reconciliation
  atomic settlement
  receipts
        |
        v
Unifying abstraction
  authoritative observation
        + semantic dependency set
        + speculative execution
        + commit-time validation
        + atomic settlement
        + durable receipt
```

The key architectural principle is:

> **Overcenter should not make an execution authoritative because it ran successfully. It should make the execution authoritative only because settlement proved that the assumptions under which it ran remain valid and that its external effects have a known, evidence-backed outcome.**

That is the FoundationDB lesson most worth carrying forward.

It also fits Overcenter's product thesis cleanly: agents remain disposable sources of judgment; execution truth is established by deterministic validation and settlement.
