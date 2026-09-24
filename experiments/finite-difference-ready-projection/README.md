# Finite-difference READY projection

## Question

Can Overcenter maintain the scheduler READY relation incrementally from graph and lifecycle deltas while preserving the declarative full recomputation as an exact oracle?

The motivating production bottleneck is already measured: project projection and `deriveReadyWork()` grow much faster than the underlying authority CAS. This experiment tests whether classic finite differencing can turn READY maintenance from project-wide recomputation into work proportional to the affected dependency frontier.

## Preregistered treatment

The declarative relation is:

```text
READY(o) =
  lifecycle(o) == UNREALIZED
  AND every dependency of o is DONE
  AND semanticResolved(o)
  AND NOT indeterminate(o)
  AND NOT conflict(o)

next =
  minimum READY by (serviceAge, obligation id)
```

The treatment compiles that relation into reconstructible auxiliary state:

```text
reverse dependency index
failing-dependency count per obligation
READY membership set
indexed min-heap ordered by (serviceAge, id)
```

A lifecycle delta mechanically updates every clause that mentions the changed relation. For the aggregate dependency clause, the derivative follows the reverse dependency index and changes only the downstream failing counts whose predicate truth changed. Self predicates update only their own obligation. Graph dependency replacement recomputes only the changed obligation's aggregate while maintaining the reverse index.

The implementation is experimental machinery under this directory. It changes no production scheduler or authority semantics.

## Oracle

The oracle evaluates the same declarative query from scratch over the complete graph and relation state after each mutation.

The experiment requires exact equality for:

- READY membership;
- READY cardinality;
- selected `readyWork` identity under replay-derived service age.

A separate production differential constructs real `State`, `HistoricalRun`, and `Receipt` inputs and compares the incremental treatment with production `deriveProjectProjection()` after every prefix of a 96-obligation control-dependency execution.

## Hostile corpus

The bounded mutation corpus includes chains, diamonds, independent work, a semantic dependency edge at the READY predicate level, lifecycle transitions, semantic-resolution withdrawal/restoration, indeterminate current realization, static-conflict blocking, service-age rekeying, dependency rebinding, obligation insertion, and leaf retirement.

The production differential intentionally uses control dependencies only. Full incremental propagation of semantic-key identity through current realization evidence is outside this first experiment.

## Negative control

The experiment deliberately omits reverse-dependency propagation in a two-node chain after the upstream becomes DONE. The full oracle must expose the stale downstream READY result. If it does not, the experiment fails.

## Scaling treatments

For constant affected frontier, graphs of 128, 512, 2,048, and 8,192 obligations contain one anchor, four direct dependents, and otherwise independent padding. The anchor toggles between `UNREALIZED` and `DONE` 400 times. Acceptance requires the full oracle to examine the graph size each mutation while the treatment touches at most five obligations.

For fan-out sensitivity, the anchor has fan-out 1, 8, 64, and 512. A transition to DONE must touch exactly `fanout + 1`. Wall-clock timings are reported but are host-dependent and are not the primary claim.

## Reproduce

```sh
npm run experiment:finite-difference-ready-projection
```

## Success criteria

The experiment is supported only if:

1. The incremental treatment and declarative oracle have exactly identical READY membership and selected work after every hostile mutation.
2. The 96-obligation production differential agrees with `deriveProjectProjection()` after every execution prefix.
3. The omitted reverse-dependency derivative negative control produces a detectable mismatch.
4. With a fixed four-node downstream frontier, the treatment touches at most five obligations per lifecycle mutation at all tested graph sizes while the full oracle examines every obligation.
5. In the fan-out treatment, touched work is exactly `fanout + 1`.
6. The experiment retains full recomputation as the oracle and changes no production scheduling or authority code.

## Non-claims

A positive result does not establish that the production scheduler should immediately replace `deriveProjectProjection()`; that current-realization provider observations can be inferred from graph deltas; that semantic-key propagation is fully incrementalized; that static effect-conflict indexes have already been mechanically differentiated; that graph replacement is always sublinear; that wall-clock speedups are portable across hosts; or that the experimental query compiler is a general-purpose incremental-view-maintenance engine.

The promotion question comes later: first establish exact semantics and the dependency-local cost law.
