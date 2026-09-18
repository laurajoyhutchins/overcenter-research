# Overcenter and Durable Execution

**Last reviewed:** 2026-09-18

## Question

How does Overcenter relate to durable-execution systems such as Temporal, Restate, DBOS, and AWS Lambda durable functions?

The short answer is:

> Durable execution primarily preserves **execution progress** across failure. Overcenter is concerned with when uncertain execution may become **authoritative project truth**.

These are complementary boundaries.

A durable-execution runtime can be an excellent place to run an Overcenter worker. It can preserve control flow, timers, messages, step results, and retries. Overcenter still needs to answer a different set of questions when a consequential external effect sits outside the runtime's own atomic durability boundary:

- Which exact project obligation authorized the effect?
- Is the worker that attempted it still authoritative?
- Did the external effect actually happen?
- Is a negative read authoritative enough to permit replay?
- Does the observed effect satisfy the exact obligation and revision being settled?
- Which durable evidence makes the resulting project state independently defensible?

The distinction is easiest to see at the classic lost-acknowledgement boundary:

```text
worker calls external provider
           |
           v
provider performs effect
           |
           X response / worker / network lost
           |
           v
durable runtime knows:
  "this step did not durably complete"

external world may be:
  effect absent
  effect present
  effect present but stale read says absent
           |
           v
Overcenter asks:
  what can authoritative readback actually prove?
```

A replay engine cannot infer external truth from the absence of a durable completion record. Some durable-execution systems provide additional mechanisms that reduce or eliminate that ambiguity for particular classes of effects. The comparison below is therefore not "Overcenter versus replay engines." It identifies the boundary that remains when effects cannot be atomically committed with the runtime's own durability record.

## What durable replay already solves

Modern durable-execution systems solve substantial problems that Overcenter should not reimplement:

- persist logical execution progress;
- resume after worker/process/machine failure;
- avoid re-executing already-recorded completed steps;
- persist timers, waits, signals, and callbacks;
- provide workflow/execution identity and retry policy;
- often provide durable messaging, queues, or state;
- in some systems, atomically couple selected application state updates with execution checkpoints.

Those are strong guarantees.

Overcenter's research thesis begins where the runtime's own journal or transaction is **not sufficient evidence about an external system**.

## Comparison

| System | Durable boundary | External-effect behavior relevant to this research | What remains outside durable replay alone |
| --- | --- | --- | --- |
| **Temporal** | Workflow history is durable and workflow code reconstructs state by replay. Non-deterministic I/O belongs in Activities. | Temporal's current AI engineering guidance describes Activities as at-least-once and recommends idempotency keys for write-side tools. Once an Activity completion is in history, replay uses that recorded result rather than re-running it. | If an external API mutation happened but the Activity completion was not durably recorded, replay does not itself prove whether the provider effect exists. Safe recovery needs idempotency, provider reconciliation, compensation, or another operation-specific mechanism for the ambiguous external effect. |
| **Restate** | A durable journal records invocations, results, communication, timers, and state; completed journal entries are replayed rather than executed again. Restate also extends durability to communication and keyed state. | Restate documents that side effects can execute more than once if failure occurs before the side effect completes or before its result becomes durable. Durable calls and Restate-owned state can provide stronger end-to-end semantics than a raw external call. | For a third-party effect that is not within Restate's durable communication/state boundary, the journal alone does not establish external truth after an unknown outcome. An external reconciliation contract is still needed when idempotency or durable callback integration is unavailable. |
| **DBOS** | Workflow progress is checkpointed in a database. Completed steps are not re-executed. DBOS can atomically commit application database changes with its durability record through DBOS transactions. | DBOS documents steps as at-least-once until completion, while DBOS transactions against a supported datasource can commit application writes and the durability record atomically, yielding an exactly-once transaction boundary. | The exactly-once database transaction guarantee is powerful precisely because the effect and checkpoint share a transaction. A third-party HTTP/provider effect outside that database still has the familiar unknown-outcome problem and normally belongs in an idempotent/retried step. |
| **AWS Lambda durable functions** | The SDK checkpoints durable operations and replays completed step results after Lambda environment loss. | AWS exposes at-least-once-per-retry by default and at-most-once-per-retry for side-effecting steps. AWS explicitly documents that neither mode alone means "exactly once across the entire workflow." | At-least-once can duplicate a non-idempotent effect after interruption. At-most-once can avoid replay but leave the workflow with an interrupted step whose external outcome may still need domain-specific reconciliation. |
| **Overcenter** | Project authority is an exact revision plus CAS settlement; execution may be disposable. Verification semantics are part of the obligation, and settlement is based on authoritative observation rather than worker assertion. | Unknown mutation outcome is a first-class state. A provider adapter classifies readback as `present`, authoritative `absent`, or `uncertain`. Only authoritative absence can make replay eligible. | Overcenter does not attempt to provide a general workflow replay runtime. Its contribution is the authority, evidence, reconciliation, and project-truth boundary around uncertain execution. |

## Temporal

Temporal's central abstraction is a durable Workflow Execution whose Event History lets workers reconstruct deterministic workflow state after failure. External I/O is moved to Activities.

That gives a useful separation:

```text
deterministic workflow state
        |
        v
Activity
  arbitrary external I/O
        |
        v
Activity result recorded in workflow history
```

Once the Activity result is durably recorded, history replay prevents the completed Activity from being logically repeated.

The difficult interval is **before** that result becomes durable.

Temporal's current AI engineering guidance says write-side tool Activities have at-least-once execution semantics and recommends idempotency keys. This is the exact interval Overcenter's mutation-certainty model is concerned with:

```text
external effect completed
        |
        X Activity completion not durably recorded
        |
        v
Activity may be attempted again
```

Temporal is not unusual here; this is the ordinary distributed-systems ambiguity between an external side effect and acknowledgement of that effect.

An Overcenter-style verifier can be used inside or after a Temporal Activity to answer a stronger domain question:

> Does authoritative provider state prove that the exact obligation is now satisfied, absent, or still uncertain?

That is different from asking whether the Activity attempt returned successfully.

### Temporal sources

- Temporal documentation: https://docs.temporal.io/
- Temporal AI engineering patterns, including Activity idempotency guidance: https://go.temporal.io/platform-hub/ai-engineering/ai-patterns
- Temporal AI reference architecture: https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture

## Restate

Restate's model is broader than simple workflow replay. Its runtime journals execution and also provides durable RPC/messaging and keyed state. When both sides of a call participate in Restate's durability model, Restate can eliminate many failure windows that exist with an ordinary third-party HTTP call.

That is an important distinction. Overcenter should not claim that Restate merely "replays functions."

Restate nevertheless documents the same residual boundary for a side effect whose result is not yet durable:

> A side effect may execute more than once if failure occurs before it completes or before its result is durably recorded.

Restate can often avoid that boundary by turning communication into a durable invocation, by using an Awakeable/persistent promise, or by placing state under its own consistency model.

Overcenter is relevant where the external system remains independently authoritative and cannot be absorbed into that runtime boundary. In that case, Overcenter's concern is not how to restart the handler. It is how to establish provider truth after the handler's knowledge is incomplete.

### Restate sources

- Durable execution overview: https://restate.dev/what-is-durable-execution
- Restate architecture/background and side-effect semantics: https://restate.dev/blog/why-we-built-restate
- Restate durable runtime overview: https://restate.dev/

## DBOS

DBOS makes the distinction between ordinary durable steps and database transactions especially clear.

DBOS workflows resume from completed checkpoints. A step that fails before completion may execute again, so external effects in ordinary steps should be idempotent.

DBOS transactions are stronger. When the application write and DBOS durability record are committed in the same supported database transaction, DBOS can guarantee that transaction commits exactly once and recovery returns the recorded output rather than rerunning it.

That is the ideal solution when it is available:

```text
application mutation
      +
durability checkpoint
      |
      v
same database transaction
```

Overcenter is aimed at effects for which this co-commit is unavailable:

```text
GitHub / cloud / SaaS / external provider mutation
      |
      X no shared transaction with orchestration state
      |
      v
independent readback + verification + settlement
```

The two designs therefore meet at a clean boundary. Use an atomic DBOS transaction when the authoritative effect lives in the same transactional database. Use reconciliation semantics when the authoritative effect is in a separate system whose commit cannot be atomically coupled to the execution journal.

### DBOS sources

- Workflow guarantees: https://docs.dbos.dev/python/tutorials/workflow-tutorial
- Architecture and step idempotency: https://docs.dbos.dev/architecture
- Transaction guarantees: https://docs.dbos.dev/golang/tutorials/transaction-tutorial

## AWS Lambda durable functions

AWS Lambda durable functions checkpoint execution operations and replay completed results after the Lambda sandbox disappears.

AWS makes the execution-semantic tradeoff unusually explicit:

- **at-least-once per retry** executes immediately and may rerun after interruption;
- **at-most-once per retry** first persists a START checkpoint and does not rerun an interrupted attempt.

AWS also explicitly says that neither mode alone gives exactly-once execution across the full workflow.

This maps directly onto Overcenter's distinction between **execution policy** and **external truth**.

At-least-once says:

> Prefer progress; the operation must tolerate repetition.

At-most-once says:

> Prefer not to repeat an attempt; interruption may require another resolution path.

Overcenter asks the next question:

> If the operation was interrupted, can authoritative provider evidence establish whether its intended effect is present or absent?

When the answer is yes, reconciliation can convert uncertainty into a safe terminal or replayable state. When the answer remains unknown, Overcenter deliberately preserves uncertainty rather than silently choosing retry.

### AWS sources

- Durable Execution SDK: https://docs.aws.amazon.com/durable-execution/
- Idempotency and retry semantics: https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/
- Lambda durable-function idempotency: https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html

## What Overcenter adds beyond durable replay

The list below describes the **architectural guarantee set**, not a claim that current `main` already implements every item in its strongest form. In particular, full lease-generation fencing, generalized realization reuse, and compact transition attestations remain architectural requirements or research targets. [`claims.md`](./claims.md) records the implementation status of each claim.

The phrase **beyond durable replay** matters. Several systems above provide capabilities stronger than replay. The claims below are not assertions that those systems cannot implement similar policies. They identify guarantees that are not implied merely by having a durable execution journal.

### 1. The executor is not the authority on success

A worker result such as:

```text
activity returned success
step returned success
process exited zero
agent says done
```

is not by itself project truth.

Overcenter commits verification semantics before execution and independently observes the provider or artifact required by the obligation.

The resulting principle is:

> A producer may create a candidate effect. It cannot self-certify that the effect satisfies project intent.

### 2. Project intent is bound to an exact authority coordinate

Durable replay normally identifies an execution and its historical steps.

Overcenter additionally binds work to the exact project state that authorized it:

```text
obligation
+ exact graph/source revision
+ exact verifier semantics
+ effect coordinate
```

A result proved under revision A cannot silently settle revision B merely because the same workflow code resumed.

### 3. External truth and execution knowledge are separate

Overcenter represents:

```text
effect truth:
  absent | present

Overcenter knowledge:
  absent | present | uncertain
```

A timeout or crashed executor changes knowledge. It does not rewrite provider reality.

This separation prevents the common category error:

```text
"the step did not complete durably"
therefore
"the side effect did not happen"
```

### 4. Replay requires authoritative negative evidence

Overcenter's recovery rule is intentionally asymmetric:

```text
verified desired effect present
    -> settle DONE

authoritatively absent
    -> replay may become eligible

missing / stale / conflicting / unreadable / incomplete
    -> RECOVERY_REQUIRED
```

This is stronger than a retry policy. It makes **proof of absence** an operation-specific precondition for replay after an uncertain mutation.

For an eventually consistent read model, a 404 may be only uncertainty, not absence.

### 5. Authority and exact state are separate dimensions

The distributed-fencing research distinguishes:

```text
execution authority:
  is this worker/epoch still allowed to act?

state identity:
  is this still the exact project revision the action was prepared against?
```

A current revision does not prove a stale worker is still authorized. A current lease does not prove the project revision is unchanged.

Durable replay identity alone does not imply both checks.

### 6. Settlement is a separate authoritative commit boundary

Execution and settlement are intentionally separated:

```text
attempt effect
      |
observe provider truth
      |
verify exact postcondition
      |
revalidate authority
      |
CAS settlement
```

The worker's control-flow history can be useful evidence, but it is not the linearization point for project truth.

### 7. Durable proof is about the resulting transition, not only replay history

Overcenter receipts and the transition-attestation research aim to preserve the minimum facts needed to justify a terminal project claim after ordinary execution machinery is gone.

That includes, conceptually:

- exact intent/obligation identity;
- exact authority revision;
- material external effect coordinates;
- authoritative observations;
- verification result;
- settlement identity;
- resulting project-state identity.

A workflow journal is optimized to recover execution. A transition attestation is optimized to defend a project-state claim.

Those can overlap, but they are not the same artifact.

### 8. Satisfaction and reuse are independent of the producer

The Bazel/Nix research treats a node as an obligation predicate rather than a remembered task completion.

That means a valid realization may come from:

- the current worker;
- a predecessor worker;
- a concurrent worker;
- a human;
- an already-existing provider object;
- a prior artifact whose exact inputs and verification still match.

Durable replay answers "what did this execution already complete?"

Overcenter's target reuse model asks "is this exact obligation already satisfied by a valid realization, regardless of who produced it?"

## Composition, not replacement

A useful deployment could look like:

```text
Temporal / Restate / DBOS / AWS durable execution
  - durable timers
  - callbacks
  - execution replay
  - retries
  - worker lifecycle
                 |
                 v
         Overcenter worker
                 |
       exact authorization
                 |
                 v
        external provider
                 |
      authoritative readback
                 |
                 v
   Overcenter verification + CAS
                 |
                 v
          project truth
```

In that architecture, the durable-execution runtime owns **how execution survives**.

Overcenter owns **what is allowed to count**.

## Precise non-claims

Overcenter does **not** claim that:

- a durable-execution engine cannot implement provider reconciliation;
- Temporal, Restate, DBOS, or AWS cannot be extended with the same verification rules;
- Git CAS is universally superior to a workflow service or transactional database;
- every external API can provide authoritative negative evidence;
- external effects become exactly-once merely because Overcenter observes them;
- Overcenter guarantees eventual completion;
- executor history is useless.

The narrower claim is:

> A durable replay record is not, by itself, sufficient evidence that an independently authoritative external side effect is present, absent, current, authorized for the exact project revision, or safe to repeat.

Overcenter is the proposed transaction/evidence layer for that gap.
