# Attempt unification

## Question

Can Overcenter safely collapse the current `ClaimFact + ExecutionAuthorityFact + EffectReservationFact` execution model into `Claim + Attempt` while reducing implementation surface and preserving recovery performance?

The candidate must not win by deleting a safety distinction. In particular, successor recovery authority must be able to reconcile an older unresolved external effect without inheriting permission to issue a second effect.

## Models

The experiment compares three bounded models.

### Legacy-shaped reference

The reference preserves the current distinctions:

- claim creates the first fenced execution generation;
- later recovery rotates execution authority;
- external mutation separately creates an unresolved effect reservation;
- replay-safe computation may retry only after previous containment termination is proved.

### Safe Claim + Attempt candidate

The candidate has only two durable conceptual records:

- `Claim` owns the semantic work;
- `Attempt` owns one fenced authority epoch.

To preserve the current safety boundary, an attempt must also distinguish `execute` from `recover`. A recovery attempt can observe and settle an older unresolved effect but cannot execute another effect. Replay-safe computation may mint another execute attempt only after containment termination is proved.

For initial replay-safe computation, claim and attempt are allowed to share one authoritative write because exact execution context is validated before claim. Effectful work still claims before preflight and creates the execute attempt only immediately before mutation.

### Unsafe single-clock controls

There are two ways to make one `Attempt` clock carry both execution fencing and external-mutation identity, and both lose a required property.

**Rotate the clock on recovery.** This fences the dead worker, but the successor clock now looks like a new executable attempt while the predecessor mutation is unresolved. Preventing duplicate mutation requires separate unresolved-effect state or a recovery-only mode, recreating the removed dimension.

**Preserve the clock on recovery.** This keeps the unresolved mutation attached to the same attempt, but the dead worker and recovery worker now share the same authority identity. Preventing stale-worker action requires a separate fencing epoch, again recreating the removed dimension.

So the key result is stronger than a naming preference:

```text
authority epoch must rotate on recovery
mutation epoch must not rotate while outcome is unknown
```

One clock cannot satisfy both constraints.


## Machine-checked two-clock necessity theorem

The bounded negative controls above now have a universal Lean proof in the pinned semantic oracle at revision `39bd16a317bc2155a17b6674a5050adaf4295c90`.

The theorem is deliberately smaller than the production transaction model. For any epoch type, assume:

```text
authorityAfter ≠ authorityBefore
mutationAfter = mutationBefore
authorityBefore = mutationBefore
authorityAfter = mutationAfter
```

The first premise is stale-worker fencing: recovery must rotate execution authority.

The second premise is unresolved-mutation continuity: while the external outcome is unknown, recovery must preserve the mutation epoch rather than silently authorizing a new mutation.

The last two premises are the proposed single-clock representation before and after recovery.

Lean derives `False`. Equivalently, if authority rotates and mutation identity persists, the two identities cannot remain aliased after recovery.

The checked theorem lives in `experiments/lean-kernel/Overcenter/TransactionKernel.lean` in the pinned oracle revision and is compiled by the existing Lean semantic-oracle workflow. This is an unbounded equality proof, not finite-state enumeration.

## Metrics

The experiment measures three things.

1. **Safety semantics.** Stale authority must fail; unresolved effects must block duplicate mutation; recovery-only authority must not execute; authoritative absence may close recovery; replay-safe computation still requires containment-death proof.
2. **Complexity.** Nonblank, non-comment source lines are counted for the bounded reference and safe candidate. This is deliberately a local architectural measurement, not a claim about whole-repository LOC before a production transplant.
3. **Performance.** Representative transactions count authoritative writes, and an in-process transition benchmark compares median effect-recovery throughput over seven runs of 200,000 transactions.

## Confirmatory criteria

The proposed collapse earns a production refactor only if all of these hold:

- the safe candidate preserves the listed recovery and replay invariants;
- candidate durable writes are no greater than the reference in successful computation, successful effect, computation recovery, and effect recovery;
- the safe candidate is smaller than the legacy-shaped reference by at least 5% SLOC;
- candidate median transition time is no more than 1.25x the reference;
- the smaller unsafe control demonstrably fails the unresolved-effect recovery case.

Failure of the SLOC criterion means the simplification is rejected even if runtime throughput is acceptable: moving the same distinction into an `AttemptPurpose` mode is not technical-debt elimination. Both single-clock negative controls must also fail in their intended way: rotating loses mutation safety, while preserving loses stale-worker fencing.

## Reproduce

```sh
node --experimental-strip-types --test experiments/attempt-unification/attempt-unification.test.ts
```

No network, provider credential, database, or model is required. Hosted confirmation must run this same command at the final exact PR head.

## Why this is structurally difficult

The current facts have deliberately different lifetimes:

- the claim is stable across recovery and binds semantic work to an exact project revision;
- execution authority is revocable and rotates whenever ownership of live execution changes;
- an unresolved external-effect reservation survives that authority rotation until authoritative observation resolves what happened.

The reservation therefore crosses an execution-generation boundary. That temporal overlap is the important property. An effect reservation is not merely an attempt log; it is durable evidence that replay is hazardous even after the actor that created the hazard is gone.

The repository has already encountered the mirror-image design once. Experimental PR #77 introduced durable `computation-intent` and `computation-attempt` facts to make pure computation look more transaction-like. That branch was not merged. The later production cutover in PR #91 deliberately used the smaller claim/generation -> physical attempt evidence -> independent observation path with no durable computation-attempt lifecycle. Pure computation does not need an uncertainty tombstone when replay safety can be mechanically re-established from containment and exact execution context.

This experiment is intentionally capable of producing a negative architectural result. A safe two-record vocabulary is useful only if it removes machinery rather than renaming execution fencing and effect reservation into extra attempt modes and branches.

A negative result means the current three semantic distinctions are carrying independent information:

- semantic claim ownership;
- current fenced recovery/execution authority;
- whether an external effect may already exist.

That does not prove the current implementation is locally optimal. It only rejects this specific collapse as a simplification.

## Non-claims

- This does not benchmark SQLite, GitHub, Go, or Rust execution latency.
- This does not decide whether the Go computation executor should remain.
- This does not prove that no other representation can reduce the same production surface. It proves only that execution-authority rotation and unresolved-mutation continuity cannot remain one aliased epoch across recovery.
- This does not authorize weakening effect reservation, exact-revision fencing, or containment-death recovery.
