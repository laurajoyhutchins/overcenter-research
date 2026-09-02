# TLA+ and a Formal Transaction/Recovery Kernel

## Scope

This note asks whether Overcenter's transaction and recovery machinery is small enough to specify usefully in TLA+ or another lightweight formal method.

The goal is deliberately narrow.

Do **not** attempt to formally specify:

- the whole Overcenter product;
- the project DAG;
- agent reasoning;
- GitHub, Linear, CI, or hosting APIs;
- every receipt or journal schema;
- scheduler policy;
- prompt behavior;
- provider-specific implementation details.

Instead, model the smallest state machine that answers one question:

> Under crashes, retries, stale workers, exact-revision drift, and uncertain external mutations, when may an attempted operation become verified project truth?

The candidate kernel is:

```text
acquire authority
       |
       v
lease + fencing epoch + exact revision
       |
       v
prepare / authorize mutation
       |
       v
external effect
       |
       +-------------------+
       |                   |
       v                   v
known outcome       uncertain outcome
       |                   |
       |               verification
       |                   |
       +---------+---------+
                 |
                 v
          exact postcondition
                 |
                 v
              settle
                 |
                 v
          durable evidence
                 |
                 v
                DONE
```

## Executive conclusion

Yes. Overcenter's transaction/recovery kernel is small enough to model usefully.

The right model is not "Overcenter in TLA+." It is a finite transition system for:

1. execution authority;
2. lease fencing;
3. exact revision identity;
4. mutation knowledge;
5. verification;
6. settlement;
7. recovery;
8. terminal evidence.

The core can be represented with one work item, two workers, two authority generations, two exact revisions, and one abstract external effect.

That is enough to ask TLC to find the most dangerous classes of bugs:

- a stale worker settling after a successor takes authority;
- a mutation being executed twice after a lost acknowledgment;
- evidence from revision A being used to settle revision B;
- settlement succeeding but its acknowledgment being lost;
- two recovery workers racing over one unresolved mutation;
- DONE becoming true without valid terminal evidence.

The smallest useful specification should therefore look more like a distributed transaction protocol than a workflow engine.

```text
          MONOTONIC / DURABLE FACTS

    effect observations
    verification evidence
    settlement evidence
    terminal proof

               ^
               |
       narrow synchronization
               |
               v

       NON-MONOTONIC KERNEL

    current lease owner
    current fencing epoch
    current exact revision
    unresolved mutation authority
```

This aligns with the conclusions in:

- [`distributed-fencing.md`](./distributed-fencing.md);
- [`foundationdb-transaction-semantics.md`](./foundationdb-transaction-semantics.md), if present under that name in this directory;
- [`transition-attestations.md`](./transition-attestations.md);
- [`calm-monotonic-state.md`](./calm-monotonic-state.md).

The formal model would tie those research threads together by checking whether the proposed composition actually preserves the intended safety properties.

## Why this is a good formal-methods boundary

Formal methods are most useful when:

- a small number of state variables interact in non-obvious ways;
- concurrency creates interleavings that are hard to enumerate mentally;
- failures can occur between any two durable steps;
- a timeout does not reveal whether an external effect happened;
- authority can change while work is in flight;
- retries are sometimes safe and sometimes dangerous;
- correctness depends on exact identity, not merely eventual convergence.

That is exactly Overcenter's transaction/recovery problem.

The kernel is also already expressed in semantic concepts instead of low-level API chatter:

```text
lease
fencing epoch
exact revision
mutation certainty
effect observation
verification
settlement
receipt / evidence
recovery
```

Those concepts map naturally to state variables and transition actions.

The full product does not.

A project graph with arbitrary amendments, agents, CI systems, GitHub operations, deployment providers, and scheduling policy would explode the state space while contributing little to the safety questions this model should answer.

The formal boundary should therefore stop at an abstract provider operation.

## Why TLA+

TLA+ is a particularly good fit because the hard part is temporal behavior under concurrency, not data-shape validation.

The model needs to describe behaviors such as:

```text
Worker A acquires authority
Worker A starts an external mutation
A's request succeeds remotely
A loses the response
A crashes
A's lease expires
Worker B acquires a newer epoch
revision changes
A wakes up
B begins recovery
```

Then it needs to ask whether any continuation can violate an invariant.

TLC is an explicit-state model checker for executable TLA+ specifications and can check both safety and liveness properties.

Reference:

- Leslie Lamport, TLA+ Tools: https://lamport.azurewebsites.net/tla/tools.html

TLC is the recommended first checker because this model should remain intentionally tiny and finite.

Apalache is a useful secondary option if the state space later becomes awkward for explicit enumeration. Apalache translates TLA+ checking problems into SMT constraints and supports bounded model checking and inductiveness checking.

References:

- Apalache: https://apalache-mc.org/
- Apalache symbolic model checking overview: https://apalache-mc.org/docs/tutorials/symbmc.html

Quint is a reasonable alternative authoring language if engineer readability becomes a stronger concern than using TLA+ directly. Quint uses the same broad state-machine style and can use Apalache as a backend.

Reference:

- Quint: https://quint-lang.org/

The recommendation is still:

> Write one authoritative TLA+ model first. Do not maintain parallel TLA+ and Quint models of the same kernel.

Two formal specifications that can drift would create the exact authority problem the model is meant to clarify.

## The state machine

Start with one logical transition.

Do not model multiple graph nodes initially.

Use two workers because one worker cannot expose stale-authority races.

Use two exact revisions because one revision cannot expose evidence attribution drift.

Use one external effect because the important issue is uncertainty about whether it happened, not the effect's domain semantics.

### Constants

Conceptually:

```tla
CONSTANTS
    W1,
    W2,
    R1,
    R2

Workers == {W1, W2}
Revisions == {R1, R2}
```

The model checker does not need real Git SHAs, UUIDs, timestamps, or hashes.

Identity can be symbolic.

### Core variables

A minimal state vector is approximately:

```tla
VARIABLES
    leaseOwner,
    leaseLive,
    fence,
    leaseFence,

    authorityRevision,
    leaseRevision,

    phase,

    effectTruth,
    mutationKnowledge,

    verifiedEffect,
    verifiedRevision,

    settlement,
    settlementRevision,
    settlementFence,

    evidenceValid
```

Where the value domains are small finite sets.

For example:

```text
leaseOwner        = None | W1 | W2
leaseLive         = TRUE | FALSE
fence             = 0 | 1 | 2
leaseFence        = 0 | 1 | 2

authorityRevision = R1 | R2
leaseRevision     = R1 | R2

phase             = Idle
                  | Authorized
                  | Mutating
                  | Uncertain
                  | Verified
                  | Settled
                  | Done
                  | Blocked

effectTruth       = Absent | Present

mutationKnowledge = None
                  | Possible
                  | Confirmed

verifiedEffect    = Unknown | Absent | Present
verifiedRevision  = None | R1 | R2

settlement        = None | Completed | Blocked
settlementRevision = None | R1 | R2
settlementFence    = 0 | 1 | 2

evidenceValid     = TRUE | FALSE
```

This is intentionally redundant in a few places.

The point of the first model is clarity and counterexamples, not minimum variable count.

## Keep external truth separate from Overcenter knowledge

This is the most important abstraction in the entire model.

A timeout after a mutation creates two possible worlds.

### World A: effect happened

```text
external truth:
    effectTruth = Present

Overcenter knowledge:
    mutationKnowledge = Possible
```

### World B: effect did not happen

```text
external truth:
    effectTruth = Absent

Overcenter knowledge:
    mutationKnowledge = Possible
```

The caller sees the same failure in both worlds.

Therefore the TLA+ action representing an uncertain provider result should be nondeterministic:

```text
MutationTimesOut ==
    phase = Mutating
    /\ mutationKnowledge' = Possible
    /\ effectTruth' \in {Absent, Present}
```

The exact syntax can differ, but the semantic point must remain.

If the model collapses `effectTruth` and `mutationKnowledge` into one variable, it cannot represent the core recovery problem.

## Model fencing separately from exact revision

The distributed-fencing research established that lease authority and repository revision protect different dimensions.

The formal model should preserve that separation.

```text
fence says:
    is this still the authorized execution generation?

exact revision says:
    is this still the exact authoritative state this operation depends on?
```

These can diverge independently.

The model must explore all four combinations:

| Fence | Exact revision | Mutation authority |
| --- | --- | --- |
| current | current | potentially allowed |
| stale | current | reject stale worker |
| current | stale | reject stale state |
| stale | stale | reject both |

If these are represented by one combined token, the model will fail to expose bugs where Git remains unchanged but execution authority moves to another worker.

## Model revision identity, not a numeric ordering

Exact revisions should usually be modeled as symbolic identities, not as increasing integers.

For the kernel, the important relationship is:

```text
observed revision == current revision
```

not:

```text
observed revision < current revision
```

Git commits are identities in a history, not database sequence numbers.

The fence, by contrast, **is** naturally monotonic.

This distinction prevents the model from smuggling Git semantics into the lease mechanism.

## Suggested actions

The first model only needs a small action vocabulary.

### `Acquire(w)`

Acquire execution authority for worker `w`.

Preconditions should require no incompatible unresolved authoritative mutation.

Effects:

```text
leaseOwner := w
leaseLive := TRUE
fence := fence + 1
leaseFence := fence + 1
leaseRevision := authorityRevision
phase := Authorized
```

A renewal of the same ownership generation should not increment the fence.

### `ExpireLease`

Makes the current lease no longer live.

It must not erase the fencing generation or unresolved mutation facts.

### `ChangeAuthorityRevision`

Moves current external/project authority from `R1` to `R2`.

This simulates:

- Git head movement;
- an amendment changing the relevant exact coordinate;
- another authority-changing event.

The old revision remains a valid historical identity. It merely stops being current.

### `BeginMutation(w)`

Requires current authority.

At minimum:

```text
leaseLive
leaseOwner = w
leaseFence = fence
leaseRevision = authorityRevision
```

This represents the narrow mutation authorization boundary.

If the design uses a prepared-operation reservation, this action is where the reservation becomes durable.

### `MutationKnownAbsent`

The provider definitively rejects the effect before it happens.

```text
effectTruth := Absent
mutationKnowledge := None
```

The execution can potentially be retried after fresh validation.

### `MutationKnownPresent`

The effect occurs and the caller receives a definite success result.

```text
effectTruth := Present
mutationKnowledge := Confirmed
```

Even then, settlement should still depend on postcondition verification when exact evidence is required.

### `MutationUncertain`

The effect may or may not have happened.

```text
mutationKnowledge := Possible
choose effectTruth from {Absent, Present}
phase := Uncertain
```

This is where model checking earns its keep.

### `Crash(w)`

The worker disappears without conveniently cleaning up all state.

The model should permit crashes after every meaningful durable boundary.

Examples:

```text
acquired but before mutation
mutation started before outcome known
outcome known before verification
verification completed before settlement
settlement committed before acknowledgement
```

### `Verify`

Observes current external truth and binds the observation to an exact revision.

```text
verifiedEffect := effectTruth
verifiedRevision := authorityRevision
```

A richer version can separate the revision being verified from current project revision if needed.

The invariant, not the action, should determine whether that evidence is usable for settlement.

### `RetryMutation`

Allowed only when recovery has established that the prior effect is absent and current authority is valid.

It must not be enabled merely because a timeout occurred.

### `Settle(w, disposition)`

Represents the authoritative Overcenter commit boundary.

Settlement should require:

- current lease/fence authority;
- correct exact revision;
- acceptable mutation knowledge;
- verification attributable to the revision being settled;
- no conflicting prior settlement.

The settlement record should capture the fence and revision under which it was accepted.

### `Recover(w)`

Recovery should not be a magical state reset.

Model it as ordinary transitions based on durable observations.

For example:

```text
Possible + verified Present
    -> do not replay
    -> proceed toward settlement or reconciliation

Possible + verified Absent
    -> replay may become eligible

Possible + no trustworthy verification
    -> remain blocked / unresolved
```

### `MarkDone`

This action should ideally disappear from the final design.

DONE is safer as a derived predicate than as a mutable command.

More on that below.

## The smallest useful invariants

Do not begin with dozens of properties.

A first model should have a very small invariant set that captures Overcenter's actual correctness thesis.

### Invariant 1: only current authority may settle

> Any authoritative settlement must have been accepted under the current valid execution authority.

Conceptually:

```tla
CurrentAuthoritySettlement ==
    settlement # None
    => settlementFence = fence
```

The full property may also bind lease identity and subject/revision identity.

This rules out:

```text
W1 gets fence 1
W1 stalls
lease expires
W2 gets fence 2
W1 wakes
W1 settles
```

That trace must be impossible.

### Invariant 2: exact-revision evidence only

> Evidence used to justify settlement must be attributable to exactly the revision being settled.

```tla
ExactRevisionEvidence ==
    settlement = Completed
    => verifiedRevision = settlementRevision
```

This rules out:

```text
verify R1
current authority becomes R2
use R1 proof to mark R2 complete
```

### Invariant 3: no blind replay after mutation uncertainty

> If an earlier attempt may have mutated external state, the mutation may not be replayed until verification establishes that the required effect is absent.

Conceptually:

```tla
ReplaySafe ==
    RetryMutationEnabled
    => verifiedEffect = Absent
```

The real model may also require evidence freshness and exact revision identity.

This is the central `may_have_mutated` property.

### Invariant 4: at most one semantic terminal settlement

> A transition/revision may have at most one terminal semantic disposition.

Identical retries can be idempotent.

Conflicting terminal results cannot both become authoritative.

Examples that must be impossible:

```text
Completed and Blocked
Completed under R1 and a second independent Completed settlement for the same semantic transition/revision
```

The model can represent this with one settlement register at first. A later refinement can model an append-only set of settlement attempts and assert uniqueness of accepted terminal meaning.

### Invariant 5: no false DONE

> DONE implies valid settlement plus valid exact-revision evidence.

Conceptually:

```tla
NoFalseDone ==
    Done
    => settlement = Completed
       /\ verifiedEffect = Present
       /\ verifiedRevision = settlementRevision
       /\ evidenceValid
```

This is probably the highest-level product invariant in the model.

### Invariant 6: stale authority cannot begin a new authoritative mutation

This is subtly different from stale authority not being allowed to settle.

> Once a worker's fence is stale, it cannot newly cross the authority-changing mutation boundary.

A worker may still finish local computation.

It may not obtain a fresh external side effect using obsolete authority.

### Invariant 7: no conflicting successor while an authorized effect is unresolved

If Overcenter adopts the prepared/reserved mutation design from the fencing research, model this explicitly:

> At most one authority epoch may own an unresolved authoritative external mutation for a subject.

This matters because fencing immediately before an API call is not sufficient if authority can transfer while the already-authorized request is in flight.

The safe sequence is:

```text
prepare / reserve
      |
external mutation
      |
known or uncertain outcome
      |
confirm / recover
      |
release reservation
```

A successor must not be allowed to issue a conflicting effect while the predecessor's already-authorized effect remains unresolved.

## DONE should be a theorem, not an assignment

One of the strongest architectural outcomes of the model would be to eliminate the idea that a worker "sets DONE."

Instead:

```text
DONE(work, revision) =
    valid terminal settlement exists
    AND settlement authority was valid
    AND required effect is established
    AND postcondition is verified
    AND verification names the exact revision
    AND terminal evidence is intact
```

The concrete product may still cache a DONE projection for performance, but the formal semantics should treat it as derived.

This meshes directly with the CALM research:

```text
immutable coordinate-scoped proof facts
              |
              v
       deterministic query
              |
              v
             DONE
```

A cached lifecycle flag can be wrong.

A theorem over exact durable facts is much harder to lie about.

## Failure scenarios worth model-checking

The model is valuable only if it deliberately generates ugly traces.

The following scenarios are the minimum useful suite.

### Scenario 1: stale worker wakes after successor acquisition

```text
W1 acquires fence 1 at R1
W1 stalls
lease 1 expires
W2 acquires fence 2 at R1
W1 wakes
W1 attempts authoritative mutation or settlement
```

Expected:

```text
W1 rejected
no authoritative effect accepted under fence 1
```

This checks distributed fencing independently of exact revision movement.

### Scenario 2: mutation applied, acknowledgement lost

```text
W1 begins mutation
external effect becomes Present
response is lost
mutationKnowledge = Possible
W1 crashes
recovery begins
```

Expected:

```text
verify effect Present
never execute the effect again
settle or reconcile using evidence
```

This is the canonical uncertain-mutation trace.

### Scenario 3: mutation not applied, acknowledgement lost

```text
W1 begins mutation
external effect remains Absent
response is lost
mutationKnowledge = Possible
W1 crashes
```

Expected:

```text
recovery must verify Absent
only then may retry become enabled
```

A timeout alone must not authorize replay.

### Scenario 4: exact revision changes after verification

```text
verify effect at R1
current authority changes to R2
attempt settlement using R1 evidence
```

Expected:

```text
settlement rejected for R2
fresh R2 evidence required
```

### Scenario 5: settlement commits, acknowledgement lost

```text
settlement becomes durable
caller loses response
caller crashes
recovery starts
```

Expected:

```text
recovery discovers existing identical settlement
converges idempotently
no second external effect
no conflicting settlement
```

This is the settlement equivalent of FoundationDB's unknown commit result problem.

### Scenario 6: two recovery workers race

```text
old mutation remains unresolved
W1 and W2 both attempt recovery
```

Expected:

```text
only current fenced authority can make an authoritative recovery transition
both may observe
at most one may commit the resolution
```

### Scenario 7: worker loses lease during verification

```text
W1 owns fence 1
external effect is present
W1 begins verification
lease expires
W2 obtains fence 2
W1 finishes verification
W1 attempts settlement
```

Expected:

```text
verification fact may remain historically valid if correctly scoped
W1 may not settle under stale fence
```

This separates monotonic evidence from current execution authority.

### Scenario 8: current revision changes while old ambiguous effect remains unresolved

```text
R1 mutation outcome becomes Possible
R1 remains unresolved
current authority becomes R2
new worker wants to mutate same subject
```

Expected behavior depends on operation semantics, but the model must force an explicit rule.

For conflicting effects, the safe default is:

```text
R2 worker cannot cross the mutation boundary
until R1 effect is reconciled
```

This is where the model can validate whether Overcenter's authority reservation is strong enough.

### Scenario 9: evidence record exists but is invalid

```text
settlement exists
verification reference exists
evidenceValid = FALSE
```

Expected:

```text
DONE = FALSE
```

This prevents "receipt row exists" from becoming equivalent to "proof exists."

### Scenario 10: conflicting settlement retry

```text
Completed settlement commits
caller later retries with Blocked
```

Expected:

```text
conflicting retry rejected
identical retry may be accepted idempotently
```

## The single nastiest trace

One composite trace is especially worth asking TLC to minimize:

```text
R1 current
W1 acquires fence 1
W1 begins authorized mutation
external mutation succeeds
response is lost
W1 crashes
lease expires
R1 -> R2
W2 acquires fence 2
W1 wakes
W1 attempts settlement
W2 attempts recovery of R1 mutation
W2 considers making an R2 mutation
```

The model should prove that no interleaving can produce:

- duplicate external mutation;
- W1 settlement under stale authority;
- R1 verification attributed to R2;
- conflicting R1 and R2 ownership of the same unresolved effect;
- DONE without a complete evidence chain.

If TLC can produce one of those outcomes, the resulting counterexample is likely to be directly actionable architecture feedback.

## Safety first

Version 1 should focus almost entirely on safety.

Check:

```text
type correctness
deadlock states
7 kernel invariants
10 failure traces
```

Do not begin by proving sophisticated liveness properties.

The danger of premature liveness modeling is that fairness assumptions can accidentally wish away real operational failures.

For example, a property such as:

```text
every unresolved mutation is eventually verified
```

is only true if the environment eventually permits verification.

GitHub could remain unavailable indefinitely.

That is not a transaction-safety bug.

The safe terminal state may legitimately be BLOCKED awaiting operator/provider recovery.

## One useful liveness property later

After safety is stable, add one constrained convergence property:

> If authority eventually stops changing, provider observations eventually succeed, and a recovery worker continues to run, every unresolved operation eventually reaches either a verified terminal settlement or an explicit safe-stop state.

In prose:

```text
stable environment
+ fair recovery attempts
+ observable provider

        eventually

settled
or
explicitly blocked
```

This is better than demanding eventual success.

The system can converge safely to "cannot prove what happened."

That is compatible with Overcenter's fail-closed philosophy.

## Do not model time literally in version 1

Leases involve expiration, but the first model does not need wall-clock arithmetic.

Represent expiration as an enabled nondeterministic action:

```tla
ExpireLease
```

Then test the authority consequences.

The safety property should not depend on whether the TTL was 30 seconds or 5 minutes.

If later work needs to reason about renewals and timeout races specifically, time can be refined into logical ticks.

Avoid real timestamps in the initial state space.

## Do not model hashes

A SHA, fingerprint, evidence digest, or transition fingerprint should be a symbolic identity.

For example:

```text
GoodEvidence
BadEvidence

R1
R2

DefinitionA
DefinitionB
```

The formal question is whether equality and attribution are checked correctly.

Cryptographic collision resistance is a separate assumption and does not belong in this model.

## Do not model GitHub

Represent a provider as a nondeterministic environment capable of:

```text
accepting an effect
rejecting with definite no-effect
accepting but losing the acknowledgement
not accepting and losing the acknowledgement
allowing later readback
changing exact authority revision
```

That captures everything the transaction kernel needs to know.

A GitHub-specific model would create a forest of irrelevant REST details.

The provider contract can later be treated as an implementation refinement of the abstract actions.

## Do not model the whole project graph

The first model should contain one transition.

The graph only becomes relevant to the kernel through a small number of facts:

```text
this transition is the subject
this graph/revision identity is current
these dependencies/evidence coordinates were assumed
```

Graph topology, joins, cancellation, amendments, and workflow soundness belong in separate graph models, closer to the Petri-net research.

The transaction kernel should treat graph authority as an input identity.

This separation is valuable:

```text
workflow correctness model
    asks whether graph semantics are coherent

transaction kernel model
    asks whether an authorized effect becomes truth safely
```

One model should not try to solve both problems.

## Suggested TLA+ skeleton

The first specification can be structurally small.

Illustrative pseudo-TLA+:

```tla
---------------- MODULE TransitionKernel ----------------
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, Revisions

VARIABLES
  leaseOwner,
  leaseLive,
  fence,
  leaseFence,
  authorityRevision,
  leaseRevision,
  phase,
  effectTruth,
  mutationKnowledge,
  verifiedEffect,
  verifiedRevision,
  settlement,
  settlementRevision,
  settlementFence,
  evidenceValid

vars == <<
  leaseOwner,
  leaseLive,
  fence,
  leaseFence,
  authorityRevision,
  leaseRevision,
  phase,
  effectTruth,
  mutationKnowledge,
  verifiedEffect,
  verifiedRevision,
  settlement,
  settlementRevision,
  settlementFence,
  evidenceValid
>>

Init ==
  /\ leaseOwner = "None"
  /\ leaseLive = FALSE
  /\ fence = 0
  /\ authorityRevision \in Revisions
  /\ phase = "Idle"
  /\ effectTruth = "Absent"
  /\ mutationKnowledge = "None"
  /\ verifiedEffect = "Unknown"
  /\ settlement = "None"
  /\ evidenceValid = TRUE

HasCurrentAuthority(w) ==
  /\ leaseLive
  /\ leaseOwner = w
  /\ leaseFence = fence
  /\ leaseRevision = authorityRevision

ReplayAllowed ==
  /\ mutationKnowledge \in {"Possible", "Confirmed"}
  /\ verifiedEffect = "Absent"
  /\ verifiedRevision = authorityRevision

ValidDone ==
  /\ settlement = "Completed"
  /\ settlementRevision = verifiedRevision
  /\ verifiedEffect = "Present"
  /\ evidenceValid

Next ==
  \/ \E w \in Workers : Acquire(w)
  \/ ExpireLease
  \/ ChangeRevision
  \/ \E w \in Workers : BeginMutation(w)
  \/ MutationSucceeds
  \/ MutationFails
  \/ MutationBecomesUncertain
  \/ Verify
  \/ \E w \in Workers : Retry(w)
  \/ \E w \in Workers : Settle(w)
  \/ Recover

Spec == Init /\ [][Next]_vars

NoFalseDone ==
  phase = "Done" => ValidDone

ExactEvidence ==
  settlement = "Completed"
  => verifiedRevision = settlementRevision

NoStaleSettlement ==
  settlement = "Completed"
  => settlementFence = fence

==========================================================
```

This is intentionally illustrative rather than ready-to-run syntax.

The implementation should be designed for readability by Overcenter contributors, not clever TLA+ compression.

## Model checking configuration

Keep the first TLC configuration tiny.

For example:

```text
Workers   = {W1, W2}
Revisions = {R1, R2}
MaxFence  = 2 or 3
```

If necessary, bound the number of retries or model fence values symbolically.

The goal is to exhaustively explore qualitatively distinct traces, not simulate production scale.

State-space growth should be controlled by abstraction, not by weakening invariants.

## What would count as a successful formalization

A useful first milestone is reached when all of the following are true:

1. The model has no provider-specific API objects.
2. Two workers can race.
3. Exact revision can change independently from lease generation.
4. A mutation timeout nondeterministically represents both "effect happened" and "effect did not happen."
5. Crashes can occur before and after every durable boundary.
6. Settlement can succeed while its acknowledgement is lost.
7. Recovery can resume from durable state without hidden worker memory.
8. The seven safety invariants pass under TLC for the finite configuration.
9. Deliberately broken variants produce counterexamples for stale settlement, blind replay, and revision-attribution bugs.
10. DONE is represented as a derived validity condition rather than trusted worker intent.

The deliberately broken variants are important.

A formal model that only says "no error found" is much less convincing than a model where removing a fence check or exact-revision check immediately causes TLC to produce the expected bad trace.

## Use mutation operators as model tests

Treat the specification itself like executable safety documentation.

Create small intentional faults:

### Fault A: remove fence check from settlement

Expected TLC result:

```text
counterexample:
W1 fence 1 -> expiry -> W2 fence 2 -> W1 settles
```

### Fault B: permit retry when `mutationKnowledge = Possible`

Expected:

```text
counterexample:
first effect Present but ACK lost -> retry -> duplicate effect
```

### Fault C: remove exact revision from evidence validity

Expected:

```text
counterexample:
verify R1 -> move R2 -> settle R2 using R1 evidence
```

### Fault D: allow successor mutation while predecessor effect unresolved

Expected:

```text
counterexample:
old request may still apply while successor executes conflicting effect
```

### Fault E: define DONE as `settlement != None`

Expected:

```text
counterexample:
settlement row exists with invalid/missing evidence -> false DONE
```

These mutation tests make the invariants understandable to engineers who do not routinely read temporal logic.

## Refinement path

Do not start with implementation-level refinement proofs.

A practical sequence is:

### Level 0: abstract protocol model

```text
lease
fence
revision
mutation truth
knowledge
verification
settlement
evidence
```

Purpose:

- validate protocol shape;
- discover impossible-to-see interleavings;
- make invariants explicit.

### Level 1: prepared-operation refinement

Add:

```text
prepared operation
reservation owner
idempotency key
unresolved effect slot
```

Purpose:

- validate cross-system mutation handoff;
- check successor fencing while provider request is in flight.

### Level 2: durable recovery facts

Add symbolic durable records corresponding to:

```text
operation receipt
verification fact
settlement attestation
```

Purpose:

- ensure recovery depends only on durable facts;
- identify which journals/telemetry are unnecessary for correctness.

This level can feed directly back into the event-sourcing/compaction research.

### Level 3: implementation conformance tests

Do not attempt a machine-checked refinement from TypeScript into TLA+ immediately.

Instead, generate canonical traces from the model and implement them as deterministic kernel tests.

For example:

```text
formal trace:
    acquire 1
    authorize
    provider applied
    ACK lost
    crash
    recover
    verify present
    settle

implementation test:
    same abstract sequence against transition kernel
```

This creates a practical bridge between the model and production code without pretending TypeScript has been formally verified.

## TLA+ versus PlusCal

PlusCal can be useful when the model reads naturally as explicit worker procedures.

For example:

```text
worker loop:
    acquire
    inspect
    mutate
    verify
    settle
```

But the kernel is fundamentally a set of concurrent state transitions with crashes and environment actions.

Raw TLA+ actions are therefore likely clearer than encoding the system as imperative worker programs.

PlusCal is reasonable if contributors find it much easier to review, but it should compile into one canonical TLA+ specification and preserve the same invariant vocabulary.

## TLA+ versus Quint

Quint has a more conventional typed syntax and may lower the entry cost for TypeScript-heavy contributors.

That advantage is real.

However, this specific kernel is small enough that TLA+ syntax is unlikely to be the main maintenance problem.

The bigger risks are:

- choosing the wrong abstraction boundary;
- accidentally merging external truth with local knowledge;
- omitting an authority dimension;
- writing weak invariants;
- adding fairness assumptions that hide failures.

TLA+ has the deepest ecosystem and clearest direct connection to TLC.

Recommendation:

```text
TLA+ + TLC first
Apalache if state explosion becomes material
Quint only if authoring ergonomics blocks adoption
```

## TLA+ versus Alloy

Alloy is excellent for finite relational structure and bounded instance finding.

It would be attractive for questions such as:

- graph schema consistency;
- uniqueness of relationships;
- immutable evidence linkage;
- authority graph constraints.

The transaction/recovery kernel is more naturally temporal.

The hard question is not whether a bad state can structurally exist in isolation. It is whether a sequence of concurrent transitions can reach it under crashes, retries, lease turnover, and uncertainty.

That favors TLA+.

Alloy may still be useful elsewhere in Overcenter, particularly for static graph/amendment constraints.

## TLA+ versus state-machine/property testing alone

Property-based tests are valuable but should come after the abstract protocol model.

Tests execute behaviors the implementation already knows how to generate.

TLC can enumerate behaviors the author did not think to write as tests.

The strongest combination is:

```text
TLA+ model
    finds abstract counterexample
          |
          v
canonical trace fixture
          |
          v
TypeScript state-machine test
```

The formal model becomes a trace generator for the dangerous edges of the protocol.

## The smallest useful formal kernel contract

The research suggests the following authoritative contract:

### Authority

An operation may cross an authoritative mutation boundary only under current fenced authority and required exact-state preconditions.

### Mutation knowledge

External effect truth and Overcenter's knowledge of that truth are separate.

Unknown outcome is a first-class state.

### Replay

Potentially effectful work is not replay-safe merely because execution failed.

Replay requires operation-specific proof that retry cannot duplicate or conflict with an existing effect.

### Verification

Verification is evidence about an exact subject at an exact authority coordinate.

It is not a free-floating boolean.

### Settlement

Settlement is the authoritative Overcenter commit boundary.

It revalidates authority and evidence before project truth changes.

### Recovery

Recovery is ordinary deterministic execution over durable facts.

It must never rely on lost process memory or infer certainty from absence of a response.

### DONE

DONE is derived from valid terminal evidence.

It is not granted by worker assertion.

That is the kernel worth formalizing.

## Architectural questions the model should force Overcenter to answer

A good formal specification exposes ambiguity in the design instead of papering over it.

The first modeling exercise should force concrete answers to these questions:

1. **When exactly is an external mutation considered authorized?**

   Before the provider call, at the provider call, or only at settlement?

2. **What prevents authority transfer while an already-authorized provider request remains unresolved?**

3. **Which token fences a stale worker at settlement?**

4. **Which exact identity binds verification to the state being settled?**

5. **What durable fact distinguishes `possible` from `confirmed` mutation knowledge?**

6. **What exact evidence is sufficient to downgrade `possible` to definitely absent?**

7. **Can a verification fact survive lease loss?**

   It probably can as a historical observation, while losing authority to settle.

8. **What makes settlement idempotent after an acknowledgement is lost?**

9. **Can two distinct settlement requests for the same transition/revision both be accepted?**

10. **What exact predicate computes DONE?**

11. **Which pieces of the journal are correctness state versus disposable execution telemetry?**

12. **What is the safe terminal outcome when recovery cannot establish effect truth?**

The formal model is valuable even before TLC runs if it makes these questions impossible to answer vaguely.

## Relationship to the distributed-fencing research

The fencing note's central result is:

```text
Authority safety     = lease generation
State safety         = exact Git revision
Cross-system safety  = prepared effect + recovery
```

The TLA+ model should encode that decomposition directly.

If a single model variable replaces two of those dimensions, the abstraction is too coarse.

If `BeginMutation` only checks the lease but not the exact revision, the model should find stale-state effects.

If settlement only checks the revision but not the lease fence, the model should find stale-worker settlement.

If successor authority can create a conflicting effect while an old request remains unresolved, the model should find a cross-system race.

This makes the formal work a direct validation of the fencing architecture rather than an independent theoretical exercise.

## Relationship to FoundationDB prior art

The FoundationDB research suggests viewing Overcenter execution as:

```text
observe
   |
speculate
   |
external effects
   |
validate dependencies and authority
   |
settle
```

The formal kernel can make that model precise.

A particularly useful analogy is the distinction between:

```text
conflict / known not committed
```

and:

```text
unknown commit result
```

Those require different recovery behavior.

For Overcenter:

```text
known no effect
    -> retry may be safe after fresh validation

may have mutated
    -> verify/reconcile before replay
```

The TLA+ model should make it impossible to accidentally share one retry transition between those cases.

## Relationship to CALM

The CALM research argues for a mostly monotonic proof graph around a small non-monotonic coordination kernel.

This formal model should cover almost exactly that non-monotonic kernel:

```text
current owner
current fence
current exact revision
exclusive unresolved mutation authority
```

Verification and settlement evidence should increasingly appear as monotonic facts.

The model can therefore help identify state variables that should **not** remain mutable operational state in the implementation.

If a variable exists only because the implementation stores a cached projection, consider deriving it instead of making it part of the formal truth model.

## Relationship to transition attestations

The transition-attestation research asks what evidence must survive after the orchestration machinery is gone.

The formal model should provide a crisp answer:

> Whatever facts are required to re-establish the terminal invariants after process memory, leases, retries, and journals disappear are correctness-critical durable evidence.

That suggests a practical compaction test.

Take a terminal model state.

Delete every variable representing transient execution machinery.

Can `ValidDone` still be established from the retained facts?

If yes, the removed state is probably telemetry or recoverable cache.

If no, the removed state is part of the durable proof contract.

That connects formal modeling directly to retention and compaction design.

## What not to prove

Do not attempt to prove:

- that GitHub is correct;
- that SHA-256 never collides;
- that workers eventually return;
- that the network eventually heals;
- that every project reaches DONE;
- that agent judgments are semantically correct;
- that arbitrary provider compensation works;
- that every project graph is sound;
- that CI is trustworthy;
- that no human administrator can bypass Overcenter.

Those are either environmental assumptions or separate correctness domains.

The kernel's promise is narrower:

> Given authoritative observations and explicit provider outcomes, Overcenter never converts uncertainty, stale authority, or mismatched evidence into false project truth.

That is both meaningful and tractable.

## Recommended repository shape if implemented later

This research note does not implement the model.

If the project decides to proceed, a small structure is enough:

```text
formal/
  README.md
  TransitionKernel.tla
  TransitionKernel.cfg
  traces/
    stale-worker.md
    lost-mutation-ack.md
    lost-settlement-ack.md
    revision-drift.md
```

Do not create a large formal-methods subsystem.

The model should remain readable in one sitting.

If it grows beyond that, split distinct concerns rather than turning `TransitionKernel.tla` into a second implementation of Overcenter.

## Recommended execution plan

### Phase 1: write the abstract model

Implement only:

```text
2 workers
2 revisions
1 transition
1 external effect
lease/fence
mutation truth + knowledge
verification
settlement
DONE predicate
```

### Phase 2: prove the model is capable of failing

Deliberately remove:

```text
fence check
exact revision check
replay guard
unresolved-effect reservation
terminal evidence requirement
```

Confirm TLC produces the expected counterexamples.

### Phase 3: restore the invariants

Run exhaustive finite checks.

Capture the explored state count and model configuration in `formal/README.md`.

### Phase 4: turn counterexample classes into implementation tests

For every high-value formal trace, add a deterministic TypeScript test to the transaction/recovery kernel.

### Phase 5: refine only where production semantics demand it

Potential later refinements:

```text
prepared mutation reservation
multiple effect identities
semantic validation/read sets
recovery resolution facts
terminal attestation chain
```

Do not add full graph semantics unless a concrete kernel invariant requires them.

## Bottom line

Overcenter's formalizable core is smaller than its codebase suggests.

The smallest useful model is:

```text
                 current authority
          lease + fence + exact revision
                        |
                        v
                 authorized effect
                        |
              +---------+---------+
              |                   |
          known result         uncertain
              |                   |
              |               verification
              |                   |
              +---------+---------+
                        |
                        v
                     settle
                        |
                        v
                durable evidence
                        |
                        v
              derived project truth
```

The core theorem is equally small:

> An uncertain or stale execution must never become authoritative project truth without current authority and exact evidence proving the transition.

TLA+ is a strong fit because that theorem depends on interleavings, crashes, retries, and nondeterministic external outcomes.

The first formal model should not prove that Overcenter always succeeds.

It should prove something more fundamental:

> Overcenter fails closed when it cannot justify the transition.

If the specification can establish that for stale leases, changed revisions, lost acknowledgements, duplicate recovery attempts, and invalid evidence, the exercise will have captured the real transaction/recovery kernel without attempting to formalize the whole product.
