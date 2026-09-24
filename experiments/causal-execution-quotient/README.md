# Causal execution quotient

## Question

Can Overcenter quotient concrete interleavings by causal independence without losing bounded safety outcomes, while retaining order when production semantics make it observable?

The experiment tests a narrow form of the Mazurkiewicz-trace/event-structure idea against current production graph, conflict, and scheduler semantics. It does **not** change authority or execution behavior.

## Preregistered hypothesis

A conservative, property-sensitive independence relation should collapse all linearizations of four disjoint three-event obligation chains into one safety trace, while a scheduler-sensitive quotient must retain claim order because current replay-derived service age makes that order observable.

A deliberately unsound rule, "different obligation IDs are independent," must collapse two conflicting provider writes that have different final outcomes. The experiment is falsified if that negative control does not expose an outcome collision.

## Model

Each independent obligation contributes the causal chain:

```text
claim -> reserve -> receipt
```

For four obligations there are 12 events. The explicit explorer enumerates every topological linearization of those four chains.

A trace key is computed from:

1. explicit causal-parent edges; and
2. the observed order of event pairs that the selected oracle says are dependent.

The canonical representative is the lexicographically least topological ordering of that dependence graph.

Two property projections are tested:

- **safety**: disjoint obligations and disjoint resources may commute;
- **scheduler**: claim/claim order remains dependent because current service-age selection observes replay order.

The experiment also reuses current production helpers to verify that:

- control and semantic dependency edges are causal;
- unordered incompatible effects on one canonical resource are reported by the production static-effect conflict index;
- explicit graph ordering removes that static conflict;
- reversing two READY claim histories preserves lifecycle and semantic-key projections but changes current `readyWork`.

## Hostile negative control

Two writes to the same provider coordinate have different desired values.

The conservative oracle must preserve two trace classes and one final outcome per class.

The intentionally unsound "different obligation IDs commute" oracle must collapse both executions into one trace class containing two different final outcomes. That collision demonstrates that obligation identity alone cannot establish independence.

## Acceptance criteria

The treatment is supported only if all of the following hold:

1. the four-chain explorer visits exactly 369,600 concrete linearizations;
2. the safety quotient collapses those linearizations to exactly one trace class;
3. the scheduler-sensitive quotient retains exactly 24 trace classes, one for each claim ordering;
4. current production graph helpers identify both control and semantic causality;
5. current production static-effect analysis rejects unordered incompatible writes to one resource and accepts the same pair when explicitly ordered;
6. reversing two READY claims leaves lifecycle statuses and semantic keys unchanged but reverses the production `readyWork` choice;
7. the unsound oracle collapses two conflicting-write executions into one trace class containing two distinct final outcomes.

The experiment is intentionally exact rather than threshold-based: every expected cardinality is part of the distinguishing criterion.

## Reproduce

```sh
npm run experiment:causal-execution-quotient
```

Hosted execution is in `.github/workflows/causal-execution-quotient.yml`.

## Interpretation boundary

A positive result supports a **read-only causal quotient** for bounded exploration and conflict analysis. It does not authorize changing the global authority head, weakening exact-revision fencing, deleting per-effect receipts, or treating all graph-disconnected obligations as independent.

In particular, current scheduler semantics intentionally retain some otherwise harmless ordering because service age is derived from replay order. Independence is therefore relative to the property being preserved.

## Non-claims

- The production fact log itself is commutative.
- Git/SQLite authority serialization can be removed.
- All provider effects expose complete static resource footprints.
- Receipt evidence can be discarded or aggregated.
- The bounded quotient proves arbitrary concurrent executions equivalent.
- DPOR is implemented or optimal.
- Event structures replace the existing obligation graph.
- Liveness properties are preserved by the safety quotient.
