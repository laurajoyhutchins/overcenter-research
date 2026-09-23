# Formal transition kernel

This directory implements the finite TLA+ model proposed in [`research/tla-formal-kernel.md`](../research/tla-formal-kernel.md).

It is intentionally not a model of all of Overcenter. It asks one question:

> Under crashes, retries, stale workers, exact-revision drift, and uncertain external mutations, when may an attempted operation become verified project truth?

## Model boundary

The model contains exactly:

- two workers (`W1`, `W2`);
- two exact revisions (`R1`, `R2`);
- one logical transition;
- one abstract external effect;
- a bounded fencing epoch;
- external effect truth separate from Overcenter's knowledge of that truth;
- verification bound to the exact mutation revision;
- settlement bound to current authority;
- durable terminal evidence;
- `Done` as a derived predicate, never an assignment.

It deliberately does not model the project DAG, provider APIs, scheduler policy, prompts, Git internals, or agent reasoning.

## Recovery refinement

A successor may acquire execution authority while an older external effect remains unresolved. That is necessary for recovery after the original worker dies.

The unresolved mutation reservation remains bound to the older mutation epoch. The successor may verify and settle that earlier effect, but it may not issue a new effect until authoritative readback has resolved the old one.

```text
old worker / fence 1
        |
  external effect
        |
   outcome unknown
        X worker dies
        |
lease expires
        |
new worker / fence 2
        |
   may verify old effect
        |
        +-- present --> settle under fence 2
        |
        +-- absent ---> retry may become eligible

but fence 2 cannot blindly issue a second effect
while the fence-1 reservation is unresolved
```

This keeps recovery possible without allowing two authority epochs to own conflicting in-flight effects.

## Safety properties

`TransitionKernel.cfg` checks seven invariants:

- `TypeOK`: every state remains inside the deliberately finite domains.
- `MutationAuthoritySafety`: every accepted mutation crossed the boundary under current fenced authority and the exact revision.
- `SettlementAuthoritySafety`: an accepted settlement was authorized at acceptance time.
- `ExactRevisionEvidence`: settlement evidence names exactly the revision being settled.
- `ReplaySafety`: a possibly effectful operation is never replayed without authoritative absence evidence.
- `ReservationSafety`: a new effect never overwrites an unresolved prior reservation.
- `NoFalseDone`: derived `Done` never becomes true without durable terminal evidence.

No liveness property is asserted. Stuttering is explicit because this first model is only a safety model.

## Negative controls

The model has five guard constants. The authoritative configuration enables all of them. Five deliberately broken configurations disable exactly one guard and must produce a counterexample:

| configuration | removed guard | expected violated invariant |
| --- | --- | --- |
| `BrokenNoFence.cfg` | current fence/lease check | `MutationAuthoritySafety` |
| `BrokenNoRevision.cfg` | exact-revision check | `ExactRevisionEvidence` |
| `BrokenNoReplayGuard.cfg` | authoritative-absence replay guard | `ReplaySafety` |
| `BrokenNoReservation.cfg` | unresolved-effect reservation | `ReservationSafety` |
| `BrokenNoEvidence.cfg` | terminal-evidence requirement in `Done` | `NoFalseDone` |

The negative controls matter because a green model is weak evidence if the specification is incapable of expressing the failures it claims to exclude.

## Resource-containment protocol model

`ResourceContainment.tla` models a second, deliberately smaller safety boundary: the trusted supervisor protocol around one exact cgroup leaf.

It does **not** model Linux CPU scheduling, memory accounting, PID accounting, Landlock, seccomp, or cgroup controller implementation. Those are exercised by the hosted kernel proof in `src/execution/confinement/proof.sh`.

The model asks:

> Once the host has pinned one exact resource-domain object for an attempt, can a stale locator or an early observation be mistaken for final resource evidence?

The finite model contains two possible cgroup-leaf identities and the supervisor lifecycle:

```text
start exact leaf
      |
worker / descendants run
      |
direct child closes
      |
kill exact leaf
      |
observe populated = 0
      |
capture final evidence
      |
remove exact leaf
```

The authoritative configuration checks:

- `TypeOK`: the state remains in the finite modeled domains.
- `ExactLeafAuthority`: kill, evidence, and removal never target a leaf other than the pinned active object.
- `FinalEvidenceSafety`: resource evidence is never final unless the active leaf has been killed and observed unpopulated.
- `RemovalSafety`: removal cannot occur before final evidence for the exact active leaf.

Two negative controls are mandatory:

| configuration | removed guard | expected violated invariant |
| --- | --- | --- |
| `BrokenResourceIdentity.cfg` | exact leaf-identity check | `ExactLeafAuthority` |
| `BrokenResourceEarlyEvidence.cfg` | empty-before-evidence ordering | `FinalEvidenceSafety` |

This formal layer is intentionally about protocol authority and ordering. The stronger physical claim that `memory.max`, `pids.max`, and `cpu.max` actually constrain hostile descendants requires the independent real-kernel proof.

## Run

Requirements:

- Java 21;
- `curl` unless `TLA2TOOLS_JAR` points at an existing local jar.

Run:

```bash
bash formal/check.sh
```

The runner pins TLA+ Tools 1.7.4 by SHA-256:

```text
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

It checks the authoritative transition model and five negative controls, then the resource-containment model and its two negative controls. Every broken configuration must fail for its expected invariant rather than merely returning a non-zero TLC exit code.

Temporary TLC state and logs live under `formal/.tlc/` and are not authoritative evidence.

### Baseline exhaustive result

With TLA+ Tools 1.7.4 and `MaxFence = 2`, the authoritative configuration currently explores:

```text
51,737 states generated
10,376 distinct states
0 states left on queue
```

TLC reports no invariant violation. The five negative controls then violate, respectively, `MutationAuthoritySafety`, `ExactRevisionEvidence`, `ReplaySafety`, `ReservationSafety`, and `NoFalseDone`.

## Interpreting `Done`

`Done` is a theorem over retained facts:

```text
valid settlement
AND settlement authority was valid
AND verified external effect is present
AND verification names the settled revision
AND durable terminal evidence exists
```

There is no `MarkDone` action.

This is deliberate. A cached lifecycle label may exist in an implementation, but the formal truth claim is derivable from evidence.

## Important assumptions

The model assumes that a `Verify` action, when it occurs, returns authoritative truth for the exact mutation coordinate. It does not prove that GitHub, a cloud provider, or any other external observer is correct.

It also does not prove eventual progress. Permanent inability to establish external effect truth may permanently prevent replay or settlement. That is the intended fail-closed safety tradeoff.


## Asynchronous effect finality and conditional liveness

`AsyncEffectKernel.tla` extends the formal boundary only where the first transition model was intentionally too coarse: an outbound request may remain able to apply after Overcenter has observed the target state as absent.

The model separates:

```text
absent at observation time
        !=
prior request is terminally unable to apply
```

It contains one original request and one retry, two fenced worker authorities, in-flight transport duplication, per-request provider deduplication, stale absence observations, settlement, and durable terminal evidence.

The authoritative configuration requires all of the following:

- current fenced authority for initial execution, retry, and settlement;
- an absence observation whose prior request is already terminal before replay;
- provider deduplication of duplicate deliveries of one request.

It checks:

- `AuthoritySafety`: stale authority never crosses an effect or settlement boundary;
- `NoUnsafeReplay`: replay is never authorized from an absence observation taken while the prior request could still apply;
- `NoDoubleExecution`: at most one semantic external effect occurs;
- `NoFalseDone`: durable `Done` never exists without exactly one established effect.

Three negative controls remove one guarantee at a time:

| configuration | removed guarantee | expected result |
| --- | --- | --- |
| `BrokenAsyncNoTerminality.cfg` | terminality-bound absence before replay | double-effect counterexample |
| `BrokenAsyncNoDeliveryDedupe.cfg` | provider deduplication for duplicated delivery of one request | double-effect counterexample |
| `BrokenAsyncNoFence.cfg` | current fenced authority | stale-authority counterexample |

This makes an adapter boundary explicit: Overcenter can prevent itself from authorizing a second logical attempt, but exactly-once external execution additionally depends on provider semantics such as request idempotency, conditional mutation, or proof that the predecessor request is terminal.

`RecoveryLiveness.tla` is deliberately separate from the safety model. It asks a conditional liveness question under explicit fairness assumptions: if a stable successor worker remains available, provider requests eventually resolve, authoritative observations eventually occur, and enabled recovery steps are fairly scheduled, does work eventually reach either `Done` or an explicit `Escalated` terminal classification?

The negative control `BrokenRecoveryNoReap.cfg` disables dead-lease reclamation while keeping a stable successor available. The expected temporal counterexample demonstrates orphaned authority: the dead owner's live lease can permanently prevent the successor from acquiring authority even though every external dependency needed for progress is available.

The liveness theorem is intentionally conditional. It does not claim that Overcenter can force a provider to resolve an operation, heal a permanently unavailable external dependency, or guarantee that arbitrary projects finish.

## Scheduler conditional liveness

`SchedulerLiveness.tla` separates scheduler progress from throughput. It models a recovered target that becomes READY only after an eventually delivered authoritative observation, with authority restoration and scheduler stepping represented as explicit weak-fairness assumptions.

The authoritative stable-set configuration requires `TargetProgress`: once the recovered target remains READY, it is eventually selected. Two temporal negative/boundary controls are mandatory:

- `BrokenSchedulerUnfair.cfg` replaces the selector with fixed priority and must produce a starvation trace.
- `SchedulerFreshFlood.cfg` retains the current fresh-first policy but abstracts an unbounded stream of newly introduced never-claimed work; it must produce a starvation trace if fresh priority can indefinitely dominate recovered work.

The second case is intentionally not labeled a broken scheduler. It identifies an assumption boundary: fixed finite-set fairness does not by itself imply liveness for an open project whose higher-priority fresh class is replenished forever.

## Service-age scheduler liveness

`SchedulerServiceAge.tla` models the candidate policy produced by the scheduler-policy comparison experiment.

For one continuously eligible target, `olderRemaining` counts the finite set of eligible identities whose service age is older than the target. Scheduling one of those identities moves its age to a new claim ordinal, so the count decreases. Arbitrarily many younger admissions are represented by `AdmitYounger` and do not increase the older set.

The authoritative configuration checks `TargetProgress` under weak fairness for authority restoration, target readiness, continuing younger admissions, and scheduler steps.

`BrokenServiceAgeNonMonotone.cfg` deliberately violates the essential age-order assumption by allowing later work to increase `olderRemaining`. TLC must find a temporal starvation trace. This makes the proof conditional on durable monotonic admission/claim ordinals rather than on wall-clock timing or an implicit scheduler cursor.
