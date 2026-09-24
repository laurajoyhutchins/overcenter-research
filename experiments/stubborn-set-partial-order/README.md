# Stubborn-set partial-order reduction

## Question

Can Overcenter replace the incomplete obligation-root race heuristic with an established persistent/stubborn-set style reduction that accounts for causal enablers of future dependent events?

This experiment is intentionally more conservative than Source-DPOR. It uses a stubborn-set closure plus sleep sets and checks the reduced trace set against exhaustive enumeration.

## Reduction rule

At each state:

1. choose one enabled seed;
2. if a selected event is disabled, add all unmet causal parents;
3. if a selected event is enabled, add every remaining event dependent with it;
4. repeat to a fixed point;
5. explore only enabled members of the closure;
6. use sleep sets to remove independent reorderings.

The crucial difference from the falsified #353 heuristic is step 2: a future conflicting event may be enabled by another obligation, so its causal prerequisites participate in the reduction frontier.

## Acceptance criteria

The treatment is supported only if reduced and exhaustive canonical trace sets are exactly equal for:

- four independent two-event obligation chains, reducing to exactly one trace;
- a scheduler-sensitive four-chain fixture, retaining exactly 24 claim-order traces;
- same-obligation future conflict;
- cross-obligation causal enabling where the conflicting event itself has no enabled same-obligation root;
- the exact five-event counterexample discovered during review of `dpor-race-backtracking`, retaining all six causal trace classes;
- every model in a generated corpus of 1,024 four-event acyclic dependency/resource graphs.

Every reduced complete execution must represent a distinct exhaustive trace class.

## Reproduce

```sh
npm run experiment:stubborn-set-partial-order
```

## Interpretation boundary

A positive result supports stubborn/persistent-set style reduction for this bounded static event model. It does not establish Source-DPOR, optimal DPOR, liveness preservation, or arbitrary dynamic-provider correctness.

The theoretical motivation is the persistent-set condition: work outside the selected set may be postponed only when it remains independent from the selected transitions; stubborn-set constructions make that future-looking condition computable by including disabled transitions and their enabling requirements.

## Non-claims

- The algorithm is Source-DPOR or Optimal-DPOR.
- The reduction is optimal.
- The 1,024-model corpus proves arbitrary graphs.
- Liveness or fairness properties are preserved.
- Dynamic effect footprints can use this relation without additional evidence.
- Production scheduling should adopt this reduction.
