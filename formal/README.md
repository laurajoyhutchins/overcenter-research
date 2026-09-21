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

It does **not** model Linux CPU scheduling, memory accounting, PID accounting, Landlock, seccomp, or cgroup controller implementation. Those are exercised by the hosted kernel proof in `runtime/overcenter-exec/proof.sh`.

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
