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

## Known bottleneck

Claim issuance is still serialized through the Git CAS authority ref. That is a correctness-preserving boundary, but it may become the next throughput limit once physical execution is highly concurrent.

This experiment intentionally does not optimize that away. The next useful measurement is whether claim issuance can be streamed/pipelined into the Go worker pool so execution begins while later frontier claims are still being committed.
