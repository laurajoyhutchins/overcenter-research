# Scheduling

Scheduling chooses among work that deterministic project semantics have already made claimable. It does not decide whether unsafe work becomes READY.

## Current selection rule

The production projection in [`src/authority/project-state.ts`](../src/authority/project-state.ts) computes a replay-derived service age for every claimable obligation:

- if the current semantic obligation has been claimed before, its service age is its most recent claim ordinal;
- otherwise its service age is its current binding/admission ordinal;
- the lowest service age wins;
- obligation ID is the deterministic tie-breaker.

In compact form:

    READY candidates
        -> derive durable service age
        -> oldest service age first
        -> obligation id tie-break
        -> one readyWork

The ordinals come from replayed durable history rather than wall-clock time or a mutable scheduler cursor.

## Why this exists

Earlier fresh-first behavior could starve recovered work when new fresh work arrived indefinitely. The scheduler policy comparison and TLA+ service-age model showed that monotonic replay-derived age gives a useful conditional liveness property without adding a separate scheduler authority.

## What is and is not proved

The maintained claim is conditional: if an obligation remains eligible, authority remains available, required observations arrive, and scheduler steps continue, a finite set of older service identities cannot be replenished by younger admissions forever.

Overcenter does not claim unconditional project completion. Provider unavailability, permanently ambiguous effects, unavailable workers, unresolved human decisions, or intentionally blocked graph structure can prevent progress indefinitely.

See [`../formal/README.md`](../formal/README.md), [`../experiments/scheduler-liveness/README.md`](../experiments/scheduler-liveness/README.md), and [`../experiments/scheduler-policy-comparison/README.md`](../experiments/scheduler-policy-comparison/README.md) for the bounded evidence and assumptions.

## Extension rule

Do not add hidden priority state to make scheduling feel responsive. If a policy matters, derive it from durable authority or give it an explicit durable semantic owner, then test starvation and recovery behavior with hostile workloads.
