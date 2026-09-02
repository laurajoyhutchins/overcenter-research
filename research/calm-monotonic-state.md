# CALM and Monotonic State

## Question

How should the CALM theorem and monotonic programming shape Overcenter's state model?

The practical question is not whether Overcenter should become a declarative logic engine, CRDT system, or classic append-only event store. It is:

> Which Overcenter facts can safely accumulate without coordination, which conclusions are only projections over those facts, and which small set of decisions genuinely require synchronization?

The answer is that Overcenter should aim for a mostly monotonic proof graph around a very small non-monotonic coordination kernel.

```text
                 authoritative systems
                         |
                  exact observations
                         v
+--------------------------------------------------+
|              MONOTONIC KNOWLEDGE                |
|                                                  |
| graph revisions       effect receipts           |
| verification facts    completion certificates   |
| settlement facts      amendment ancestry        |
| dependency proofs     recovery resolutions      |
+-------------------------+------------------------+
                          |
                  deterministic query
                          |
               READY / DONE / BLOCKED
                    current projections
                          |
                          v
+--------------------------------------------------+
|          NON-MONOTONIC COORDINATION KERNEL      |
|                                                  |
| claims  leases  fencing  unresolved mutations   |
| exact-current checks  exclusive authorization   |
+-------------------------+------------------------+
                          |
                          v
                   verified mutation
```

The design goal is not "never mutate a row." The design goal is:

> Do not coordinate facts whose truth only grows.

Mutable state should be reserved for questions that can actually be invalidated by later information.

## Executive conclusion

Overcenter currently talks about several things as if they were states of an object:

- READY;
- EXECUTING;
- WAITING;
- BLOCKED;
- DONE;
- verified;
- current head;
- dependency satisfaction;
- mutation certainty;
- proof availability.

CALM suggests separating these into two categories.

### Durable facts

Durable facts should normally be immutable once admitted:

- graph revision `R` contains transition `T`;
- graph revision `R` says `T` depends on `D`;
- provider `P` was observed at exact coordinate `C` with value `V`;
- operation `O` produced effect identity `E`;
- verification `V1` established predicate `Q` at exact authority coordinate `C`;
- settlement `S` was accepted under lease epoch `L`;
- completion certificate `K` proves transition `T` for graph revision `R`;
- amendment `R2` supersedes `R1`;
- recovery evidence resolved an earlier unknown effect as present or absent.

New facts can be added without rewriting old truths.

### Current projections and coordination decisions

These are inherently non-monotonic because later information may invalidate a prior answer:

- which graph revision is current;
- which Git ref SHA is current;
- whether a transition is READY now;
- whether a transition is DONE in the current graph;
- whether an execution lease is still valid now;
- whether no competing lease exists;
- whether an unresolved mutation may safely be retried;
- whether an exact-head precondition still holds;
- whether a proof remains available for exclusive consumption.

These should be derived, checked against authority, or synchronized at narrow boundaries rather than persisted as broad mutable orchestration truth.

The key architectural move is therefore:

> Make historical truth coordinate-scoped and monotonic. Make "current" a projection.

## Prior art

### CALM theorem

CALM stands for Consistency As Logical Monotonicity.

Hellerstein and Alvaro summarize the practical result as a correspondence between logical monotonicity and the ability to implement a distributed computation consistently without coordination. A monotone program can learn more facts and produce more conclusions without retracting conclusions it already made. A non-monotone program may have to wait or coordinate because unseen information can invalidate a previous result.

The useful Overcenter test is simple:

```text
Suppose another valid fact arrives later.

Can it make this conclusion false?

    no  -> candidate monotone fact or derivation
    yes -> current projection, incomplete-world query,
           or synchronization boundary
```

Reference:

- Joseph M. Hellerstein and Peter Alvaro, "Keeping CALM: When Distributed Consistency is Easy": https://arxiv.org/abs/1901.01930

### Formal CALM result

Ameloot, Neven, and Van den Bussche formalized the connection using relational transducers. Their result is useful here because it makes clear that coordination freedom is a semantic property, not merely a property of a specific database implementation.

Reference:

- Tom J. Ameloot, Frank Neven, and Jan Van den Bussche, "Relational transducers for declarative networking": https://arxiv.org/abs/1012.2858

### Bloom and points of order

Bloom made CALM operational as a programming discipline. A particularly useful idea is identifying "points of order": places where asynchronously accumulated information is consumed by a non-monotonic operator.

This is a useful review technique for Overcenter. The interesting code is not merely every database update. The interesting code is wherever a decision depends on:

- absence;
- uniqueness;
- latest/current identity;
- negation;
- completeness of a set;
- exclusive ownership;
- a minimum/maximum that can still change;
- a timeout interpreted as authority loss;
- an aggregation whose input universe is not sealed.

References:

- Peter Alvaro et al., "Consistency Analysis in Bloom: a CALM and Collected": https://dsf.berkeley.edu/papers/cidr11-bloom.pdf
- Peter Alvaro et al., "Dedalus: Datalog in Time and Space": https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-173.html

### Lattices

BloomL generalized monotonicity from set growth to arbitrary semilattices. This matters because Overcenter has several values that are better understood as increasing knowledge rather than append-only sets.

For example, mutation certainty can be ordered by information content:

```text
                         CONFLICT
                        /        \
             CONFIRMED_PRESENT  DEFINITELY_ABSENT
                        \        /
                          UNKNOWN
```

A new observation can move the system upward in knowledge. It should not move a conclusively proven effect back to `UNKNOWN`.

Reference:

- Neil Conway et al., "Logic and Lattices for Distributed Programming": https://www2.eecs.berkeley.edu/Pubs/TechRpts/2012/EECS-2012-167.html

### A more general 2026 formulation

Hellerstein's 2026 "Coordination Criterion" generalizes the same intuition over partially ordered execution histories: specifications whose observable outcomes are monotone under history extension admit coordination-free implementations, while specifications whose outcomes can be invalidated by later history intrinsically require coordination.

This is useful for Overcenter because the design question is fundamentally semantic. The goal is not to remove SQL transactions. The goal is to make the synchronized portion of the specification as small as possible.

Reference:

- Joseph M. Hellerstein, "The Coordination Criterion": https://arxiv.org/abs/2602.09435

## The most important technique: coordinate-scoped monotonicity

Many Overcenter claims look non-monotone only because they are underspecified.

Consider:

```text
transition X is DONE
```

That statement can become false after:

- the repository head moves;
- an amendment changes X;
- a verifier contract changes;
- an input dependency changes;
- the graph adds a prerequisite.

But this statement is different:

```text
transition X was proven complete
for graph revision R,
using source revision S,
with effect E,
under verification contract V,
using evidence set Q
```

That historical statement should never become false merely because the project later changes.

The rule should be:

> If a fact can be invalidated by a newer authority state, add the authority coordinate to the fact rather than mutating the old fact.

Useful coordinates include:

```text
project identity
graph revision
graph derivation version
transition identity
source Git SHA
pull-request head SHA
provider object revision
verification contract version
effect identity
lease epoch
operation identity
settlement identity
```

A coordinate-scoped fact is often monotone even when its unqualified current projection is not.

## Classification of Overcenter state

| Surface | Monotonic facts | Non-monotonic projection or decision | Recommendation |
| --- | --- | --- | --- |
| Receipts | request digest, invocation identity, exact effect identity, provider response, readback evidence | pending, unresolved, retryable now, current attempt owner | Preserve terminal facts; synchronize only unresolved operations |
| Verification | exact observation, verifier identity/version, evidence digest, result at authority coordinate | currently verified, latest check state, still applicable to current graph | Make verification immutable and coordinate-bound |
| Graph definition | graph revision, nodes, edges, executor declarations, derivation version | current graph revision | Treat amendments as new graph revisions |
| Graph status | historical lifecycle observations and proofs | current READY/EXECUTING/WAITING/BLOCKED/DONE | Derive status instead of authoring it |
| Dependency satisfaction | predecessor completion certificates for fixed graph revision | satisfaction when dependency universe can still change | Seal dependency universe with graph revision |
| READY | graph enablement under fixed revision | authority to execute now | Split enablement from execution authorization |
| DONE | completion certificate for exact graph and authority coordinates | DONE in current project | Persist certificate, derive current DONE |
| Current head | observation that ref F pointed to SHA S | ref F points to S now | Re-read or use provider compare-and-swap |
| Amendments | new graph revision, parent/supersession relation | which revision is current | Never rewrite old graph truth |
| Leases | grant record, epoch issuance, settlement record | valid owner now, unexpired now, no competitor | Keep in synchronized kernel |
| Mutation certainty | evidence that an effect is present/absent | unresolved operation may be safe to retry now | Use monotone terminal knowledge plus compact unresolved state |
| Proofs | proof identity and evidence | proof available for exclusive consumption | Separate proof truth from proof-use coordination |

## Receipts

Receipts should be among Overcenter's most monotonic objects.

A receipt should answer what happened under exact coordinates. Once written and validated, it should not be edited to track the current world.

A useful receipt shape is:

```text
Receipt {
    operation_id
    semantic_command
    request_digest
    authority_before
    effect_identity
    authority_after_observation
    result_digest
    evidence_refs
    resolution_kind
}
```

A later provider mutation does not invalidate the receipt. It only means the receipt is no longer a statement about current provider state.

### Do not turn receipts into current-state registers

Bad pattern:

```text
receipt.status = "verified"
receipt.status = "stale"
receipt.status = "superseded"
```

Preferred pattern:

```text
Receipt(O, E, C1)
Verification(V, O, C1)
Supersedes(C2, C1)
```

Then a query determines whether receipt `O` remains sufficient for the current coordinate.

### Terminal receipts versus execution telemetry

CALM does not imply retaining every event forever.

Once mutation uncertainty is resolved, the durable correctness fact may be much smaller than the execution history that produced it.

For example:

```text
EffectConfirmed(operation_id, effect_ref, digest)
```

or:

```text
EffectDefinitelyAbsent(operation_id, evidence_digest)
```

may be sufficient after settlement. Heartbeats, provider polling attempts, scheduler wakeups, transient retry errors, and superseded recovery scratch state can remain retention-bounded telemetry.

This aligns with the transition-attestation research already in this directory: preserve proofs, not exhaust.

## Verification evidence

Verification should be modeled as accumulated evidence, not a mutable boolean.

Avoid treating this as durable truth:

```text
verified = true
```

Prefer:

```text
VerificationFact {
    verification_id
    subject
    predicate
    authority_kind
    authority_coordinate
    verifier_contract
    evidence_digest
    evidence_refs
    result
    observed_at
}
```

If a later graph or head revision changes, the old verification fact remains true about its old coordinate. It simply may no longer satisfy the query for current completion.

This eliminates the need to "invalidate" old evidence in place.

### Negative verification results are also facts

A failed verification can also be immutable when scoped correctly:

```text
verification V observed that predicate P failed at coordinate C
```

The current query may later find a successful verification at `C2`.

Do not rewrite the old failure to success. Both are useful historical facts.

## Dependency satisfaction

Dependency satisfaction initially looks non-monotonic because it uses a universal condition:

```text
READY(A) iff every dependency of A is DONE
```

Universal quantification is dangerous when the input universe can grow. If another dependency may appear later, a prior "all dependencies are done" answer can be revoked.

Overcenter has a natural solution: a sealed graph revision.

For exact graph revision `R`:

```text
Deps_R(A) = finite immutable dependency set defined by R

Done_R = monotonically growing set of valid completion certificates

DepsSatisfied_R(A) := Deps_R(A) subset-of Done_R
```

Once `DepsSatisfied_R(A)` becomes true, adding additional completion evidence cannot make it false.

If an amendment adds dependency `D`, that does not mutate the truth of `DepsSatisfied_R(A)`. The amendment creates a new graph revision `R2`:

```text
Deps_R2(A) != Deps_R(A)
```

and Overcenter evaluates `DepsSatisfied_R2(A)` independently.

### Consequence

Overcenter should not need an authoritative mutable `dependencies_satisfied` field.

It needs:

- immutable graph definitions;
- exact graph revision identity;
- completion certificates;
- a deterministic dependency query.

The graph revision acts as a closed-world seal for the dependency set.

## READY should be split into two concepts

READY currently tends to conflate monotonic graph reasoning with non-monotonic execution authorization.

Split it.

### 1. Enabled by graph

```text
EnabledByGraph(node, R)
```

This can include:

- all dependencies in sealed revision `R` have completion certificates;
- required immutable inputs exist;
- required positive predicates have proofs;
- executor declaration is valid;
- no graph-definition condition positively rules the transition out.

For fixed `R`, this can often be derived monotonically.

### 2. Authorized to execute now

```text
AuthorizedToExecuteNow(node, R)
```

This can require:

- `R` is still the current project definition;
- expected Git head still matches;
- provider preconditions still hold;
- no conflicting current lease exists;
- caller owns the latest valid lease/fencing epoch;
- unresolved mutation state does not prohibit a new attempt.

This is genuinely non-monotonic and should remain synchronized.

Conceptually:

```text
graph R -----------+
completion proofs -+--> EnabledByGraph ----> acquire authority
other proofs ------+                           |
                                               + current R?
                                               + exact head?
                                               + no competing lease?
                                               + latest fence?
                                               |
                                               v
                                      execution authorization
```

This reduces the synchronized meaning of READY to the final authorization membrane rather than requiring every upstream graph calculation to participate in coordination.

## DONE should be a certificate, not a mutable lifecycle row

Overcenter should strongly prefer:

```text
DoneCertificate {
    project_ref
    graph_revision
    transition_id
    transition_definition_digest
    source_revision
    effect_identity
    verification_contract
    evidence_refs
    settlement_ref
    verified_at
}
```

over:

```text
transition.status = DONE
```

The certificate is historical truth. It remains valid forever for the coordinate it names.

Current completion becomes a query:

```text
CurrentDone(node) =
    current graph revision is R
    AND a valid DoneCertificate exists
        for node under R
        with applicable authority coordinates
```

An amendment does not "undo" an old DONE row. It creates a new current graph coordinate under which the old certificate may or may not be reusable.

This removes an entire family of rollback and status-repair behavior.

## Amendments

CALM provides a particularly clean model for project amendments.

An amendment should add a new graph fact:

```text
GraphRevision(R1, definition_1)
GraphRevision(R2, definition_2)
Supersedes(R2, R1)
```

Everything true about `R1` remains true about `R1`.

Only this query is non-monotonic:

```text
CurrentGraph(project) = R2
```

Where Git owns graph definition currentness, Overcenter should prefer reading current Git authority rather than maintaining an independent authoritative pointer.

### Carry-forward evidence

Some amendments should permit previous completion evidence to satisfy a transition in the new revision, but only when equivalence is mechanically proven.

Represent that as another positive fact:

```text
CarryForwardCertificate {
    from_graph_revision
    to_graph_revision
    transition_id
    prior_completion_certificate
    equivalence_contract
    equivalence_evidence
}
```

A carry-forward certificate may be issued only if deterministic software can establish that all semantically relevant properties remain equivalent, for example:

- transition definition unchanged;
- required inputs unchanged;
- relevant dependency closure unchanged or safely strengthened in a provable way;
- verification contract unchanged;
- resulting state predicate unchanged;
- effect identity remains sufficient.

Otherwise evidence does not transfer.

This converts "should DONE survive this amendment?" from hidden state migration into an explicit proof obligation.

## Current-head identity

Current Git head is intrinsically non-monotonic.

This historical fact is monotonic:

```text
ObservedRef(ref=main, sha=A, observation=O1)
```

This claim is not:

```text
main == A now
```

A newer push invalidates it.

Overcenter should therefore avoid authoritative mutable mirrors such as:

```text
current_head_sha = A
```

unless they are explicitly disposable caches with source coordinates.

At mutation boundaries, use the real authority:

- read the current ref;
- compare against the expected exact SHA;
- use provider compare-and-swap or expected-old-value semantics where available;
- fail closed if currentness cannot be established.

CALM does not remove this synchronization. It explains exactly why it is required: "no newer head exists" is a negative claim over an open world.

## Mutation certainty

Mutation certainty is naturally modeled as increasing knowledge.

A useful partial order is:

```text
                        CONFLICT
                       /        \
            CONFIRMED_PRESENT  DEFINITELY_ABSENT
                       \        /
                         UNKNOWN
```

Interpretation:

- `UNKNOWN`: the evidence is insufficient to decide whether the external effect occurred;
- `CONFIRMED_PRESENT`: authoritative evidence proves the effect exists;
- `DEFINITELY_ABSENT`: authoritative evidence proves the effect did not occur;
- `CONFLICT`: Overcenter has incompatible conclusive evidence and must fail closed.

A new observation joins with existing knowledge.

Examples:

```text
UNKNOWN + readback confirms effect
    -> CONFIRMED_PRESENT

UNKNOWN + provider proof no mutation occurred
    -> DEFINITELY_ABSENT

CONFIRMED_PRESENT + duplicate confirmation
    -> CONFIRMED_PRESENT

CONFIRMED_PRESENT + conclusive absence evidence for same exact effect identity
    -> CONFLICT
```

Do not regress terminal certainty to `UNKNOWN` merely because a later retry or observation failed.

### Why unresolved operation state is still mutable

The question:

> May another attempt safely execute this operation now?

is non-monotonic.

It depends on current ownership, timeout, fencing, and whether external mutation is still unresolved. A compact mutable operation row is therefore justified while uncertainty remains.

The useful lifecycle is:

```text
mutable while uncertain
        |
        v
conclusive authority evidence
        |
        v
immutable terminal fact
        |
        v
discard ordinary execution telemetry when safe
```

This is not classic event sourcing. It is closer to proof-oriented compaction.

## Proof truth and proof consumption are different species

A common state-model smell is combining:

```text
this proof exists and is valid
```

with:

```text
this proof has not yet been exclusively consumed
```

The first is monotonic. The second is coordination state.

Prefer separate concepts:

```text
Proof {
    proof_id
    subject
    predicate
    authority_coordinate
    evidence_digest
}

ProofUse {
    proof_id
    authorization_id
    lease_epoch
    consumer
}
```

A proof never stops being historically true merely because something used it.

If a proof is single-use for protocol reasons, exclusivity belongs in `ProofUse`, enforced by a uniqueness constraint, lease, fencing rule, or other synchronized primitive.

This separation should be applied anywhere Overcenter currently mutates evidence rows with fields such as:

- `consumed_at`;
- `used_by`;
- `active`;
- `current`;
- `invalidated_at`.

Those fields may be legitimate, but they should trigger the question: is the fact itself changing, or only its current authorization relationship?

## Lifecycle status should be a projection vocabulary

READY, EXECUTING, WAITING, BLOCKED, and DONE remain useful product concepts. CALM suggests they should not be the deepest source of truth.

A possible derivation is:

```text
DONE
    = valid completion certificate for current graph coordinate

EXECUTING
    = valid current execution authorization / lease

READY
    = graph-enabled
      AND current authority checks pass
      AND no current exclusion exists

WAITING
    = required positive graph predicates are not yet established
      AND no terminal block has been proven

BLOCKED
    = explicit blocking predicate is established
      OR required authority cannot presently be established safely
```

A status row may be cached for UI or indexing, but it should be rebuildable from authority and durable proofs.

### Warning about BLOCKED

BLOCKED deserves care because it can mean two different things:

1. a positive durable fact, such as "required provider permanently rejected capability X";
2. a current inability to prove readiness, such as "GitHub is unavailable right now."

The first can be monotonic if properly scoped.

The second is a transient projection and should not become permanent project truth merely because an observation failed.

## The irreducible coordination kernel

CALM is valuable partly because it makes clear what should not be removed.

Overcenter genuinely needs synchronization for a small set of safety questions.

### 1. Exclusive execution authority

Two workers cannot both independently conclude that they hold exclusive mutation authority for the same transition.

Keep:

- leases;
- claims;
- ownership identity;
- expiry rules;
- fencing epochs/tokens;
- atomic acquisition.

### 2. Current revision checks

A mutation that depends on exact source state must establish that its precondition still holds.

Keep:

- exact Git revision checks;
- expected-old-object / compare-and-swap semantics;
- graph-currentness checks at authorization boundaries.

### 3. Unresolved external effects

Blind retry is unsafe when an effect may already have occurred.

Keep compact synchronized state until mutation certainty becomes terminal.

### 4. Exclusive proof or resource use

Where the protocol truly requires one-time consumption or one active owner, absence of another claimant must be synchronized.

### 5. Small Overcenter-owned current registers

Some current pointers may genuinely belong to Overcenter, such as a continuation cursor or active execution horizon where no external authority owns that fact.

These should be recognizable registers with explicit CAS/version semantics, not mixed into append-oriented evidence.

## Mutable state reduction opportunities

The following state is a strong candidate for deletion, demotion to cache, or replacement by proof derivation.

### Mutable graph lifecycle rows

If READY, WAITING, BLOCKED, and DONE can be recomputed from graph revision plus evidence, they should not be authoritative state machines.

### Current-head mirrors

Provider currentness should come from provider authority at safety boundaries. Local mirrors may exist only as cache hints.

### Mutable verification flags

Replace `verified=true/false` as authority with immutable verification facts and current applicability queries.

### Dependency counters

Avoid maintaining counters such as:

```text
remaining_dependencies = 2
remaining_dependencies = 1
remaining_dependencies = 0
```

when the graph revision and completion certificates can derive the answer. Counters are attractive but introduce repair obligations when amendments or stale updates occur.

### Status copies in projections

Linear, dashboards, scheduler state, and similar projections may cache status for usability. Projection drift should be repaired from authority, never the other way around.

### Evidence invalidation mutations

Avoid rewriting prior evidence to stale/invalid if the actual meaning is only "not applicable to current coordinate." Preserve the fact and derive applicability.

### Historical attempt state

Once an operation is conclusively settled and compacted into terminal effect evidence, ordinary retry chronology should not remain required for correctness.

## Suggested internal fact model

Overcenter does not need to adopt Datalog to benefit from CALM. A relational or document schema can still make the distinction explicit.

A useful conceptual fact vocabulary is:

```text
GraphRevision(project, revision, definition_digest, derivation_version)
TransitionDefined(revision, transition, definition_digest)
DependsOn(revision, transition, prerequisite)
Supersedes(new_revision, old_revision)

AuthorityObservation(observation, authority, subject, coordinate, value_digest)
EffectReceipt(operation, effect_identity, authority_coordinate, result_digest)
VerificationFact(verification, subject, predicate, coordinate, evidence_digest)
SettlementFact(settlement, transition, lease_epoch, disposition, evidence_digest)
CompletionCertificate(certificate, revision, transition, evidence_digest)
CarryForwardCertificate(from_revision, to_revision, transition, evidence_digest)
RecoveryResolution(operation, resolution_kind, evidence_digest)
```

Then keep a much smaller mutable set:

```text
CurrentLease(subject) -> { owner, epoch, expires_at }
UnresolvedOperation(idempotency_scope, key) -> recovery state
OvercenterOwnedCurrentRegister(key) -> { version, value }
```

Even if the implementation uses ordinary mutable Postgres tables, thinking in these types creates a strong separation between accumulating truth and coordination state.

## Query examples

### Current DONE

```text
R = current authoritative graph revision

DONE(T) if
    CompletionCertificate(C, R, T, ...)
    and certificate evidence remains valid for R
```

No status mutation is required when `R` changes. The query result changes because the current coordinate changes.

### Dependency satisfaction

```text
for every D in Dependencies(R, T):
    CompletionCertificate(_, R, D, ...)
```

Because `Dependencies(R, T)` is sealed by exact `R`, positive completion knowledge only grows.

### READY

```text
EnabledByGraph(R, T)
    = dependencies satisfied
      + required positive proofs exist

READY(T)
    = EnabledByGraph(R, T)
      + R is still current
      + exact provider preconditions hold
      + no conflicting execution authority exists
```

The first half can be broadly cached and asynchronously propagated. The second half belongs near lease acquisition.

### Safe retry

```text
SafeRetry(O) if
    mutation certainty == DEFINITELY_ABSENT
    and no current conflicting attempt owns O
```

The conclusive absence proof is monotonic. Current ownership is not.

## Design pressure tests

Every new durable field should answer these questions.

### Test 1: Can new information invalidate it?

If no, prefer an immutable fact.

If yes, identify the exact coordination reason.

### Test 2: Is the value missing an authority coordinate?

If adding revision, epoch, verifier, or effect identity turns a mutable claim into immutable history, add the coordinate.

### Test 3: Is this really currentness?

Fields named with concepts such as these deserve scrutiny:

```text
current
latest
active
available
ready
done
valid
remaining
unresolved
owner
```

They are often projections or coordination registers.

### Test 4: Is this an absence claim?

Examples:

```text
no competing lease
no newer commit
no unsatisfied dependency
no unresolved mutation
no blocking condition
```

Absence over an open world is non-monotonic. Either seal the universe or synchronize the decision.

### Test 5: Can this row be reconstructed?

If the answer is yes from authoritative definitions plus immutable proofs, the row should normally be a cache rather than project truth.

### Test 6: Is history being rewritten because applicability changed?

Do not rewrite old facts merely because the current graph moved. Preserve the historical coordinate and change the query.

## Recommended architectural changes

### P0: Establish the fact/register distinction

Document and encode two categories of durable storage:

```text
FACT
    immutable or knowledge-monotone
    exact authority coordinates
    safe to retain independently of current state

REGISTER
    explicitly current/exclusive/unresolved
    versioned or fenced
    synchronization semantics documented
```

Make every new table or durable record declare which category it belongs to.

### P0: Make completion certificate-shaped

Define a canonical completion certificate that binds:

- project;
- graph revision;
- transition identity and definition digest;
- exact input/source coordinate;
- effect identity;
- verification evidence;
- settlement evidence;
- verifier/derivation contract versions.

Derive DONE from this certificate rather than maintaining completion as an independent lifecycle fact.

### P0: Split graph enablement from execution authorization

Expose an internal distinction between:

```text
ENABLED_BY_GRAPH
AUTHORIZED_TO_EXECUTE_NOW
```

Only the second needs current coordination.

The user-facing product may still say READY, but the kernel should know which half is monotonic.

### P0: Seal dependency reasoning by graph revision

All dependency predicates must be evaluated relative to an exact immutable graph revision.

Avoid mutable dependency counters or cross-revision DONE transfer.

### P1: Split proof identity from proof use

Proof rows should be immutable evidence.

Exclusive-use state should live in a separate fenced/unique authorization structure.

### P1: Make amendments create new semantic coordinates

An amendment should never mutate historical graph truth. Store parent/supersession relationships and make currentness an authority query.

### P1: Add explicit carry-forward certificates

Reuse prior completion only after deterministic equivalence analysis. Make reuse evidence-visible rather than implicit.

### P1: Model mutation certainty as increasing knowledge

Use a join-like transition model from unknown toward conclusive effect presence or absence. Contradictory terminal evidence should fail closed rather than last-write-win.

### P1: Compact resolved operation state aggressively

Once external effect certainty is terminal and settlement requirements are satisfied, preserve the terminal proof and allow attempt telemetry to expire.

### P2: Audit mutable columns as a coordination budget

For every mutable correctness-sensitive column, record:

```text
what later fact may change this value?
why does that change require synchronization?
what authority owns the current value?
can exact coordinates make the fact immutable?
can the value instead be derived?
```

If there is no compelling answer, the mutable column is probably accidental orchestration state.

### P2: Make caches visibly disposable

Any materialized view for READY/DONE/frontier/current provider observations should carry:

- source authority coordinates;
- derivation contract/version;
- cache generation/version;
- enough identity to detect staleness.

Correctness must survive deleting the cache.

## Things CALM should not tempt Overcenter to do

### Do not replace the transaction kernel with CRDT enthusiasm

Leases, exclusive claims, exact-head compare-and-swap, and unresolved mutation handling are precisely the places where coordination is required. Making them eventually consistent would weaken Overcenter's core safety model.

### Do not build a generalized event-sourcing platform

Monotone facts do not require retaining every event forever. Terminal certificates can compact long execution histories.

### Do not weaken fresh authority checks

A historical observation is not current truth. CALM reinforces the difference rather than eliminating it.

### Do not automatically transfer evidence across amendments

A new graph revision is a new coordinate. Reuse requires proof.

### Do not confuse commutativity with monotonicity

Operations that commute can still participate in queries that are non-monotonic. Conversely, a monotonic conclusion may be computed over richer data than a simple CRDT set. The relevant property is whether additional valid information can revoke an observable conclusion.

## Relationship to other Overcenter research

This CALM analysis complements several other research threads in this directory.

### Transition attestations

Transition attestations answer what durable proof should survive. CALM explains why those compact, coordinate-bound proofs can accumulate safely while mutable execution chronology is disposable.

### Git transaction substrate

Git compare-and-swap and immutable object identity are natural tools for the non-monotonic current-head boundary. Git objects themselves are highly monotonic facts; mutable refs are current registers.

### Distributed fencing

Fencing is part of the irreducible coordination kernel. CALM says not to spread fencing everywhere, only to the point where an exclusive current authorization must be established.

### FoundationDB transaction semantics

Optimistic validation is another way to isolate non-monotonic checks at commit time. Speculative computation can remain broad and parallel; authoritative commit checks current conflict conditions.

### Kubernetes/Flux reconciliation

Reconciliation is excellent for rebuilding projections from accumulated facts and authoritative observations. It is insufficient for the narrow places where Overcenter requires exclusive mutation authority or transaction-like settlement.

### Bazel/Nix graph derivation

Immutable derivation inputs make CALM reasoning easier. A graph revision acts as the sealed universe needed to make dependency-satisfaction conclusions stable.

## A proposed Overcenter invariant set

CALM suggests a small family of architecture-level invariants worth making explicit.

### Fact immutability

A durable fact never changes semantic meaning after admission. Corrections are represented by new facts with explicit relationships or conflict evidence.

### Coordinate completeness

Every correctness-relevant proof names the exact authority coordinate over which it is valid.

### Projection disposability

Deleting READY/DONE/frontier/status caches cannot destroy the ability to reconstruct current project truth.

### Currentness isolation

Queries requiring "current," "latest," "none," or exclusive ownership are localized to explicit authority or coordination boundaries.

### Proof monotonicity

Additional compatible evidence can strengthen certainty but cannot erase previously established historical truth.

### Conflict preservation

Contradictory conclusive evidence becomes an explicit conflict state and fails closed. It is never silently resolved by write order.

### Amendment immutability

A project amendment creates a new graph coordinate rather than rewriting the prior coordinate.

### Evidence transfer by proof only

Evidence from one coordinate satisfies another coordinate only through an explicit deterministic carry-forward proof.

## Practical end state

The cleanest Overcenter architecture would have three semantic layers.

```text
1. AUTHORITATIVE / MONOTONIC FACTS

   graph definitions
   exact observations
   effect receipts
   verification facts
   settlements
   completion certificates
   amendment ancestry
   recovery resolutions

                 |
                 v

2. DERIVED PROJECT VIEW

   dependency satisfaction
   graph-enabled transitions
   READY candidates
   DONE
   BLOCKED / WAITING
   horizon completion
   frontier

                 |
                 v

3. COORDINATED EXECUTION MEMBRANE

   establish current graph/head
   acquire lease
   issue/check fence
   resolve ambiguous mutation
   atomically authorize effect
```

The middle layer should be cheap to recompute and safe to discard.

The bottom layer should be small enough that its invariants are obvious, testable, and eventually formally specifiable.

The top layer should be durable enough that a fresh worker can reconstruct what is true without replaying agent transcripts or orchestration exhaust.

## Final recommendation

Use CALM as an architectural lint rule for Overcenter:

> Every time deterministic software wants to persist a mutable orchestration status, ask whether it can instead persist an exact positive fact and derive the status.

The desired asymmetry is:

```text
many immutable facts
few mutable registers
very few synchronized decisions
```

Overcenter should accumulate evidence that makes project truth inevitable, then coordinate only at the narrow boundary where an actor is about to acquire exclusive authority or mutate a current external resource.

That produces a system with fewer stale-state repairs, fewer cross-session races, less lifecycle bookkeeping, smaller recovery state machines, and a transaction kernel whose synchronized behavior is small enough to reason about directly.

In one sentence:

> Overcenter should stop storing as mutable state what can be stated once as an exact fact and recomputed forever.
