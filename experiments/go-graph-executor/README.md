# Go graph executor experiment

This experiment asks one question:

> Does Go earn its toolchain cost by making a wide Overcenter graph frontier physically concurrent without becoming a second source of graph truth?

The intended boundary is:

```text
durable facts
      |
      v
deterministic projection
      |
      v
executable frontier
      |
      v
durable exact-generation permits
      |
      v
Go executor
  - bounded concurrency
  - cancellation
  - capability/spec validation
  - attempt evidence
      |
      v
trusted observation and settlement
```

The Go package has no dependency edges, graph traversal, lifecycle states, settlement authority, or durable scheduler state. A restart is expected to reconstruct current authority and hand a fresh set of exact-generation envelopes to a fresh executor.

## Stress shape

The deterministic test fixture contains 1,000 obligations:

- 700 independent
- 100 nodes arranged in dependency chains
- 100 hostile unordered provider-effect conflicts
- 50 already-realized
- 25 executions that fail
- 25 executions that hang until cancellation

The initial executable frontier is exactly 760 obligations. The graph layer withholds downstream chain nodes, conflicting work, and already-realized work before Go receives an envelope.

The unordered conflict nodes deliberately model a hostile or legacy externally-constructed state. Current admission rejects such conflicts earlier; the frontier check is a defensive fail-closed proof.

## Claims

The experiment is meant to distinguish these claims:

1. **Frontier derivation is deterministic.** Concurrency does not decide what may run.
2. **Physical execution is order-insensitive.** Concurrency 1, 8, and 500 produce the same normalized attempt evidence for the same non-hanging frontier, even though completion order changes.
3. **Cancellation is evidence, not success.** Hung work produces cancelled attempt evidence without fabricated output.
4. **Execution identity is fenced.** Run identity, exact generation, authority commit, capability digest, and execution-spec digest survive the Go boundary.
5. **Old evidence cannot cross a generation change.** Reacquiring execution authority makes earlier attempt evidence stale before interpretation.
6. **The executor is disposable.** It owns no durable queue or project lifecycle state.

Attempt evidence is not a settlement receipt. Successful execution still requires independent authoritative observation before it can become project truth.

## Pipelined claim issuance

Claim issuance remains serialized through the Git CAS authority ref, but the executor does not need to wait for an entire frontier batch. As soon as one ordinary claim commits, its exact-generation permit can be handed to a long-lived disposable Go worker pool while later claims are still being committed.

The transport is deliberately NDJSON over stdin/stdout. It is not a queue and carries no durable scheduling state.

There are two distinct handoff paths:

1. **Computation handoff.** Work whose execution boundary cannot mutate an external provider may stream immediately after the claim commits. If the executor is known to have died before dispatch, the run is reconstructed from Git and a fresh execution generation fences out the abandoned permit.
2. **Effect handoff.** Work that may mutate an external provider must commit the existing `effect_reservation` before crossing the process boundary. The reservation commit is carried in the Go attempt evidence. If the process dies after reservation, the effect outcome is ambiguous and blind replay is prohibited. Independent observation must reconcile the reservation before another effect can begin.

That distinction is the important recovery result:

```text
claim committed
    |
    +-- computation never dispatched
    |       -> known executor death
    |       -> reacquire generation
    |       -> safe fresh computation
    |
    +-- effect reservation committed
            -> effect may have happened
            -> NO blind replay
            -> observe / reconcile
            -> settle READY, DONE, or RECOVERY_REQUIRED
```

Pipelining therefore hides some serialized authority latency without weakening mutation certainty. It does not make Git claims concurrent, and it does not turn unknown effect outcome into retryable work.

## Remaining bottleneck

The authority path still performs serialized Git commits for claims and, for effectful work, reservations. The next useful measurement is not whether Go can execute more work concurrently; that is already established. It is how much claim/reservation throughput can be improved or amortized without weakening exact-revision authority, recovery, or effect fencing.
