# Overcenter Claim Taxonomy

## Why separate the claims

"Reliable autonomous execution" can accidentally bundle several very different promises:

- **safety** — bad project truth is not accepted;
- **liveness** — useful work eventually makes progress;
- **provenance** — terminal claims remain explainable and independently attributable;
- **reuse** — valid prior realizations can satisfy current obligations without unnecessary re-execution.

Overcenter should state these separately.

A system can have excellent safety and poor liveness. It can have durable execution without durable provenance. It can preserve provenance without supporting semantic reuse. Treating those as one generic "reliability" claim makes the architecture harder to evaluate and easier to overstate.

This document distinguishes:

- what the current executable prototype demonstrates;
- what the research architecture proposes;
- what Overcenter explicitly does not yet claim.

## Claim status vocabulary

| Status | Meaning |
| --- | --- |
| **Demonstrated** | There is an executable test or live hosted proof on the current main branch for the stated scope. |
| **Architectural requirement** | The research says the property is required, but current main does not yet prove the full form. |
| **Research target** | Proposed direction whose exact implementation/guarantee remains open. |
| **Non-claim** | Explicitly outside the guarantee. |

## 1. Safety

Safety asks:

> What bad authoritative states must never be accepted, even if workers crash, race, retry, lie, or lose acknowledgements?

Safety is Overcenter's strongest current claim family.

### S1. Executor success is not sufficient for DONE

**Status:** Demonstrated.

The Git kernel owns postcondition verification. A worker cannot supply a custom verifier or arbitrary observation at settlement time.

A worker may report success and still fail verification.

```text
worker says success
      |
      X
      |
kernel-owned observation
      |
verification
      |
only then settlement
```

**Claim:**

> Project truth does not advance merely because the executor says its action succeeded.

### S2. Claims are exact-revision fenced

**Status:** Demonstrated for Git authority.

A claim names the exact authority revision it observed. If authority moved before the claim CAS, the stale claim is rejected.

**Claim:**

> A work attempt cannot silently claim a different repository/project snapshot than the one from which it was derived.

### S3. External effect truth is not inferred from execution failure

**Status:** Demonstrated for the current verifier contracts.

Wrong-but-real external state becomes `RECOVERY_REQUIRED`, not `READY`.

Provider/readback failure becomes uncertainty, not absence.

**Claim:**

> Failure to establish the desired effect is not automatically proof that no effect happened.

### S4. Replay requires authoritative absence

**Status:** Demonstrated for current main's proof adapters within their declared consistency model.

```text
verified desired state -> DONE
authoritative absence  -> READY
anything else          -> RECOVERY_REQUIRED
```

**Claim:**

> After a potentially effectful attempt, replay is permitted only when provider-specific evidence establishes that replay will not blindly duplicate the unresolved effect.

**Important scope:** Whether a negative read is truly authoritative is a provider-adapter contract. A separate hostile eventually-consistent experiment explores the case where missing/stale readback must remain uncertain.

### S5. Missing authority fails closed

**Status:** Demonstrated.

If the authoritative Git ref disappears, observational surfaces do not reinterpret that as empty/idle project state.

**Claim:**

> "Cannot observe authority" is not equivalent to "there is no work."

### S6. Lost settlement acknowledgement does not create a second semantic result

**Status:** Demonstrated.

Repeating reconciliation for a run after a successful-but-unacknowledged settlement returns the existing durable receipt.

**Claim:**

> Recovery from a lost acknowledgement is idempotent at the semantic run/settlement level.

### S7. Independent effects may execute concurrently

**Status:** Demonstrated.

Two independent obligations can remain `EXECUTING` simultaneously, and fresh recovery processes can settle independent effects through one Git authority ref.

**Claim:**

> Serializing authority updates through one CAS coordinate does not require global serialization of independent external effects.

### S8. Known conflicting effect coordinates do not race by accident

**Status:** Demonstrated for the canonical GitHub commit-status adapter.

For that adapter, the effect coordinate includes:

- repository identity;
- exact commit;
- normalized status context.

Identical desired states are explicitly modeled as commuting. Incompatible desired states on the same canonical coordinate must be graph-ordered or are projected as `BLOCKED`.

**Claim:**

> Where an adapter can define canonical mutation-domain semantics, Overcenter can turn effect conflict into deterministic graph/claimability logic instead of scheduler luck.

**Non-claim:** The prototype does not yet provide universal alias/conflict detection across arbitrary providers.

### S9. Local executor state is not project authority

**Status:** Demonstrated by hosted GitHub Actions proof.

The prior hosted proof established that an authority-untrusted executor can corrupt local Git configuration, refs, kernel source, and cache without redefining the centrally committed obligation or the trusted verifier's provider coordinate.

The current hosted workflow goes further: the worker job has `contents: read` but no `statuses: write`, emits a candidate effect intent, and a separate trusted broker job owns provider write authority and execution-generation authority. Live workflow run `35389453056` exercised this boundary at exact source revision `f8a883d6214d76b0b609eb05e3798d6238d108cc`: the worker's authority-ref rewrite and provider status-write attempts both returned HTTP 403; the broker performed the declared effect in execution generation 2; fresh recovery rotated to generation 3 and settled `DONE` from canonical GitHub readback.

**Claim:**

> Destruction or corruption of disposable worker-local state does not, by itself, alter authoritative project truth.

**Stronger hosted claim:**

> In the demonstrated GitHub Actions boundary, the disposable worker cannot perform the provider mutation directly because GitHub does not grant that job the required write permission.

### S10. Execution-generation fencing is separate from exact revision

**Status:** Demonstrated within the Git kernel execution-permit boundary; model-checked in the formal kernel.

The distributed-fencing research shows that an exact claimed project revision alone cannot reject a stale worker when execution authority changes while that claimed revision remains the same. The Git prototype records the authority rotation as a separate durable fact.

Required predicate:

```text
current execution generation
AND
exact expected project revision
```

**Claim:**

> A stale execution generation is rejected at the kernel mutation/settlement boundary even if the claimed project revision is unchanged.

Each generation carries an ephemeral execution capability. Only its SHA-256 digest is durable. A fresh recovery process cannot reconstruct the prior capability from Git; trusted recovery rotates the run to a successor generation and stale permits then fail closed.

**Evidence boundary:** `test/git-kernel.test.ts` exercises unchanged-revision generation rotation and stale-permit rejection; destructive recovery experiments rotate authority after worker loss. `formal/TransitionKernel.tla` independently checks `MutationAuthoritySafety`, and `BrokenNoFence.cfg` must produce its counterexample.

**Non-claim:** This does not fence arbitrary provider calls made outside the trusted kernel boundary. `acquireExecution` remains a trusted broker/supervisor operation and is not part of the worker-facing contract.

### S11. An unresolved authorized effect must block conflicting successor effects

**Status:** Demonstrated within the Git kernel effect-reservation boundary; model-checked in the formal kernel.

A new authority epoch may need to recover an older uncertain effect, but it must not issue a conflicting successor effect until that reservation is resolved.

**Claim:**

> An unresolved mutation reservation survives execution-authority rotation and blocks a successor generation from issuing another effect through that boundary until authoritative observation settles the uncertainty.

The reservation is committed before the trusted effect wrapper invokes mutation. Successor generations may reconcile it. Authoritative presence settles `DONE`; authoritative absence releases replay; uncertain negative evidence leaves the reservation recovery-bound.

**Evidence boundary:** kernel regression tests cover presence and authoritative-absence handoff; the disposable-worker, eventual-consistency, concurrency, and stress experiments exercise recovery with fresh generations. `formal/TransitionKernel.tla` independently checks `ReservationSafety`, and `BrokenNoReservation.cfg` must produce its counterexample.

The normal `runCoreLoop` path now commits the reservation before invoking the trusted effect handler. The handler receives no `ExecutionPermit`. A negative regression proof blocks the reservation CAS and establishes that the handler is not called.

**Non-claim:** Low-level experimental callers can still invoke provider code outside `runCoreLoop`; JavaScript itself is not a capability sandbox. Physical denial of provider authority depends on the execution substrate. GitHub Actions job permissions demonstrate one concrete substrate boundary, not a universal one.

### S12. DONE should be derivable from evidence

**Status:** Demonstrated for the current Git fact/receipt projection; broader durable-attestation sufficiency remains an architectural requirement.

The intended semantic rule is:

```text
DONE =
  valid terminal settlement
  AND exact verification
  AND required effect / realization established
  AND sufficient durable evidence
```

A cached lifecycle field may exist, but it should not be the deepest source of truth.

The pure replay and projection-reconstruction tests derive `DONE` from obligation, claim, observation, verification, and receipt facts after materialized projection state is discarded. The formal kernel separately checks `NoFalseDone` and requires the broken no-evidence model to produce a counterexample. This does not yet prove that the proposed compact transition-attestation format is sufficient for every provider or future storage backend.

## Safety assumptions and non-claims

Overcenter does not prove:

- that GitHub, Git, cloud providers, or filesystems are internally correct;
- that SHA-256 or Git object identity is collision-proof in an absolute mathematical sense;
- that a provider's documented consistency model is true;
- that a hostile administrator with authority over the trusted substrate cannot bypass policy;
- that every external API supports safe reconciliation;
- that external effects execute exactly once.

The narrower safety goal is:

> Given the observations and authority assumptions the adapter declares, uncertainty, stale authority, or mismatched evidence must not be silently converted into false project truth.

## 2. Liveness

Liveness asks:

> If the desired result is possible, under what assumptions will the project eventually advance?

Overcenter intentionally makes weaker liveness claims than safety claims.

### L1. Recovery can continue after total worker loss

**Status:** Demonstrated for the Git experiment.

A fresh worker can reconstruct an unresolved exact run from central Git authority after the predecessor's local repo, cache, database, and process memory are gone.

**Claim:**

> Worker-local survival is not required for recovery.

This is a recoverability claim, not a guarantee of eventual completion.

### L2. Independent work can continue around unrelated uncertainty

**Status:** Demonstrated in the two-effect experiment.

One run can remain uncertain while an independent obligation is reconciled or retried according to its own evidence.

**Claim:**

> Uncertainty need not globally freeze unrelated effect coordinates.

### L3. Overcenter does not guarantee eventual completion

**Status:** Non-claim.

The project may remain blocked indefinitely if:

- authoritative provider readback never becomes available;
- negative evidence is never strong enough to permit replay;
- a human decision never arrives;
- a required external system remains down;
- no authorized worker executes;
- the graph is intentionally blocked;
- recovery evidence remains permanently ambiguous.

This is deliberate.

> Safety may require indefinite loss of progress when external truth cannot be established.

### L4. Fair scheduling is not currently proven

**Status:** Non-claim.

The current graph is a finite DAG and has useful structural progress properties, but the prototype does not prove scheduler fairness, resource availability, or eventual worker assignment.

### L5. Provider convergence is an environmental assumption

**Status:** Non-claim.

If a provider uses eventual consistency, Overcenter may poll/reconcile, but cannot prove the provider will ever converge unless that property is supplied by the environment/provider contract.

### L6. Compensation is not universal recovery

**Status:** Non-claim.

Some workflows can compensate after partial effects. Overcenter does not assume that every effect has a correct inverse.

## 3. Provenance

Provenance asks:

> After execution infrastructure disappears, what evidence explains why a terminal project claim is legitimate?

### P1. Git history preserves claim/recovery/settlement ancestry

**Status:** Demonstrated.

The Git experiment stores project state in immutable Git objects and advances authority by ref CAS. Claim and settlement commits remain reachable in history.

**Claim:**

> The authoritative state transition has durable revision identity rather than existing only in process memory.

### P2. Receipts bind settlement to the exact run and claim

**Status:** Demonstrated.

Receipts contain material identities such as:

- run ID;
- obligation ID;
- claimed revision;
- claim commit;
- disposition;
- verification result;
- observation;
- settlement commit.

**Claim:**

> A terminal result can be traced to the exact claimed execution coordinate and the evidence used to settle it.

### P3. Provider identity should be canonical, not sandbox-relative

**Status:** Demonstrated for the hardened GitHub commit-status proof.

The verifier uses the numeric GitHub repository ID, exact commit SHA, normalized context, and fixed GitHub API authority rather than trusting the executor's mutable `origin`.

**Claim:**

> Evidence identity should remain meaningful after the executor's local naming environment is destroyed or corrupted.

### P4. Provenance is not the same thing as execution exhaust

**Status:** Architectural requirement.

The transition-attestation research separates durable proof from disposable operational telemetry.

Long-term proof should preserve facts that materially establish:

- intent;
- exact inputs;
- authority;
- effects;
- observations;
- verification;
- settlement;
- result identity.

It should not require permanent retention of every heartbeat, scheduler wake, duplicate response, or local cache event.

### P5. Compact transition attestations are a research target

**Status:** Research target.

The proposed direction is an in-toto-style statement with an Overcenter-specific predicate, potentially signed/witnessed separately.

**Non-claim:** The current prototype does not yet implement a complete cryptographically portable attestation format, trust-root evolution, or external transparency witness.

### P6. Provenance should survive execution-runtime replacement

**Status:** Architectural requirement.

A project-state claim should not become unverifiable merely because the original worker runtime, orchestration database, or ephemeral credential no longer exists.

This is one of the principal reasons to separate project evidence from ordinary durable-execution history.

## 4. Reuse

Reuse asks:

> When may existing verified work satisfy a current obligation without running another producer?

This is primarily a research/architecture direction rather than the strongest current implementation claim.

### R1. Obligation identity, not run identity, should control reuse

**Status:** Architectural requirement.

A run is one attempt.

An obligation is the semantic requirement.

```text
obligation O
   |
   +-- run A -> realization X
   +-- run B -> realization Y
   +-- human  -> realization Z
```

Any realization can potentially satisfy O if exact identity and verification rules permit it.

### R2. Reuse requires complete semantic inputs

**Status:** Architectural requirement.

A realization must not be reused if relevant hidden inputs changed.

Candidate identity includes, where applicable:

- source revision;
- graph revision;
- dependency realizations;
- policy/verifier version;
- material configuration;
- external authority coordinate.

This is the Bazel/Nix lesson applied to project obligations.

### R3. Verification policy is part of reuse validity

**Status:** Architectural requirement.

If the acceptance predicate changes, a prior realization may need re-verification even when the artifact itself is unchanged.

### R4. External effects are not ordinary cache hits

**Status:** Safety constraint.

A previous external mutation cannot be treated as reusable merely because a prior run says it happened.

Provider state must still be observed at the correct effect coordinate and verified against the current obligation.

### R5. Reuse should be producer-independent

**Status:** Research target.

The intended model does not privilege "agent-produced" over "human-produced" or vice versa.

What matters is exact evidence.

### R6. Current prototype does not yet implement a general realization cache

**Status:** Non-claim.

The current Git kernel demonstrates recovery, verification, concurrency, and settlement semantics. It should not be described as already providing Bazel-like arbitrary realization reuse across all obligation types.

## 5. Cross-category interactions

The categories constrain one another.

### Safety versus liveness

```text
uncertain external effect
        |
        +-- retry immediately -> better apparent liveness, weaker safety
        |
        +-- wait for proof    -> stronger safety, possible indefinite block
```

Overcenter intentionally chooses the second branch for consequential unresolved effects.

### Provenance versus compaction

```text
keep all execution history forever
  -> easy audit, expensive/noisy

delete everything after DONE
  -> cheap, unverifiable

retain semantic proof
  -> target architecture
```

### Reuse versus provenance

Safe reuse depends on evidence being sufficiently precise to establish:

- what exact obligation was satisfied;
- which inputs and dependencies were used;
- which verifier accepted it;
- whether the evidence is still valid.

Provenance is therefore not ornamental. It is an input to reuse.

### Liveness versus reuse

Better reuse can improve liveness by avoiding fragile repeated execution.

But reuse itself must not become an escape hatch around exact authority and verification.

## 6. Claim review checklist

When adding a new README/research claim, classify it explicitly.

### Safety

- What bad state is claimed impossible?
- What exact authority/evidence assumptions are required?
- Is there an executable counterexample test with the guard removed?
- Does the claim hold under lost acknowledgement?
- Does it distinguish unknown from absent?

### Liveness

- What progress is promised?
- Under which fairness/provider/network assumptions?
- Can uncertainty block forever?
- Is the statement actually only recoverability rather than eventual progress?

### Provenance

- Which evidence survives?
- What exact identity does it bind?
- Can an independent verifier understand it after the worker disappears?
- Which execution telemetry can be discarded?

### Reuse

- What exact semantic key makes reuse valid?
- Which hidden inputs could invalidate it?
- Does reuse require authoritative readback for external effects?
- Can verification policy changes invalidate or revalidate the realization?

For a layer-by-layer witness map, see [`proof-obligations.md`](./proof-obligations.md).

## Bottom line

The strongest compact statement of the current research program is:

> **Safety:** never turn stale authority, uncertain effects, or mismatched evidence into false project truth.  
> **Liveness:** continue whenever safe evidence permits, but do not promise progress when truth remains unknowable.  
> **Provenance:** retain enough exact evidence that terminal project truth survives the execution machinery that produced it.  
> **Reuse:** satisfy immutable obligations from any valid exact realization, without rerunning disposable producers unnecessarily.

Those are four separate claims and should remain separate in implementation, testing, and documentation.
