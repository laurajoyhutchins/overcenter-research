# Adapter diagnosability

## Question

Can a small discrete-event-system analysis classify whether an adapter protocol can ever distinguish `mutation occurred` from `mutation did not occur` using only its declared observations, and can it detect when that distinction arrives too late to make authority reuse safe?

## Preregistered hypothesis

For the bounded finite-state corpus below, a synchronized two-world product over equal observable traces will:

1. classify deliberately recoverable and deliberately non-diagnosable protocols correctly;
2. distinguish eventual diagnosability from diagnosis before a consequential retry, authority release, or DONE transition;
3. emit an explicit indistinguishable execution witness for every non-diagnosable protocol;
4. agree with an independently implemented depth-12 trace enumerator on whether ambiguity persists at the bounded horizon;
5. fail the correlated-receipt case when the receipt observation is deliberately collapsed so mutation and non-mutation produce the same observation.

The experiment is falsified if any preregistered fixture is misclassified, a required witness is absent, the independent oracle contradicts the product checker, or the uncorrelated-receipt negative control survives.

## Treatment

The experiment models a provider adapter as a finite transition system. States carry hidden mutation reality (`occurred` or `not-occurred`). Transitions may emit an observation visible to recovery and may be marked consequential when correctness depends on knowing mutation reality.

The checker constructs a synchronized product of two executions:

- unobservable transitions may advance either side independently;
- observable transitions advance together only when both sides emit the same observation;
- a product state is ambiguous when the two sides disagree about mutation reality.

A reachable cycle consisting entirely of ambiguous product states is reported as non-diagnosable. If there is no ambiguous cycle, the checker reports the longest observable path that can remain ambiguous. Safe diagnosability additionally requires that no consequential transition be reachable while the observer is still in an ambiguous product state.

This experiment intentionally uses a bounded finite-state abstraction. It does not yet model arbitrary provider state, real time, or unbounded fairness assumptions.

## Fixtures

Phase 1 fixed seven synthetic protocols before hosted execution:

1. `undispatched`: connection failure proves no mutation path exists.
2. `ambiguous-timeout`: commit and reject worlds both yield timeout and indefinitely identical negative observations.
3. `receipt`: an authoritative correlated receipt distinguishes the two worlds.
4. `stale-get`: an indefinitely stale GET keeps commit and non-commit worlds observationally identical.
5. `bounded-eventual-webhook`: one stale observation is allowed, then a bounded webhook guarantee distinguishes the worlds.
6. `too-late`: a receipt eventually distinguishes the worlds, but authority release is reachable while they are still ambiguous.
7. `same-final-state`: an idempotent mutation and no mutation both produce the same desired resource state forever.

Expected classifications:

| Protocol | Diagnosable | Safe-diagnosable |
| --- | --- | --- |
| `undispatched` | yes | yes |
| `ambiguous-timeout` | no | no |
| `receipt` | yes | yes |
| `stale-get` | no | no |
| `bounded-eventual-webhook` | yes | yes |
| `too-late` | yes | no |
| `same-final-state` | no | no |

### Phase 2: real GitHub status boundary

Only after Phase 1 passed exact-head hosted evaluation, the unchanged checker was given three slices of the already-established GitHub commit-status uncertainty boundary.

Those slices are grounded in independent prior evidence:

- `adapter-uncertainty-exploration` at `c4c3564bb02618642fcb9d046686772f7adb8224` showed that definitely-not-dispatched and possibly-committed-but-hidden worlds collapse to the same durable recovery state unless stronger transport evidence is retained.
- `transport-not-dispatched-evidence` at `0420435e83f4fd66cbeed4f3093b3c97efa78bdb` established the fresh-socket boundary: failure before TLS `secureConnect` yields trusted `NOT_DISPATCHED`; failure after `secureConnect` remains `UNKNOWN`.
- `github-status-not-dispatched-release` at `6b238e23491792dc7a8734038b82f4741a4eae8e` established on the production path that only the trusted pre-`secureConnect` witness may release the reservation; post-`secureConnect` reset and HTTP 502 remain unresolved.

The checker itself is unchanged. The three added protocol slices are:

| GitHub status slice | Expected diagnosable | Expected safe-diagnosable | Derived recovery decision |
| --- | --- | --- | --- |
| pre-`secureConnect` failure / `NOT_DISPATCHED` | yes | yes | safe to release |
| post-`secureConnect` reset / `UNKNOWN` | no | no | ambiguous, do not release |
| HTTP 502 after request dispatch | no | no | ambiguous, do not release |

This phase is falsified if the unchanged diagnoser disagrees with any of those independently established runtime decisions, if the independent depth-12 oracle disagrees with the diagnoser, or if obtaining the expected answer requires modifying the checker.

## Independent oracle

The product checker is not allowed to grade itself. A separate brute-force enumerator expands complete transition traces to depth 12, groups them only by their emitted observation sequence, and asks whether a group still contains both mutation realities.

For every fixture classified non-diagnosable, at least one depth-12 ambiguous observation sequence must remain. For every fixture classified diagnosable, none may remain at depth 12.

This bounded oracle is a bug detector for the checker, not an independent proof of diagnosability.

## Negative control

The `receipt` fixture is mutated so `RECEIPT_PRESENT` and `RECEIPT_ABSENT` both become the single observation `RECEIPT`. The checker must then classify the protocol as non-diagnosable. If it remains diagnosable, the experiment fails.

## Reproduce

```sh
npm run test:adapter-diagnosability
```

No network, provider credential, production database, or LLM is required.

## Acceptance criteria

The experiment is informative only if:

1. all seven fixture classifications exactly match the preregistered table;
2. every non-diagnosable fixture emits a concrete ambiguous-cycle witness;
3. `too-late` is diagnosable but not safe-diagnosable, with `release-authority` identified while ambiguity remains;
4. the independent depth-12 oracle reports persistent ambiguity for all and only the three non-diagnosable fixtures;
5. the uncorrelated-receipt negative control is killed;
6. the experiment runs deterministically with Node type stripping and no runtime dependency additions.
7. the unchanged checker classifies the GitHub pre-`secureConnect` slice as safe-diagnosable;
8. the unchanged checker classifies both post-`secureConnect` reset and HTTP 502 as non-diagnosable and therefore unsafe for reservation release;
9. the derived three-way GitHub boundary exactly matches the independently established production-path result.

## Interpretation boundary

A positive result would show that DES-style diagnosability is mechanically useful on a deliberately tiny effect-protocol abstraction and that safe diagnosability expresses a distinction Overcenter cares about: knowing the outcome eventually is weaker than knowing it before authority can be reused.

Phase 2 performs that next falsifier against the already-understood GitHub commit-status boundary. A positive exact-head result would strengthen the case for using diagnosability as adapter admission tooling, but would still not make the checker production authority: the soundness of each adapter abstraction and the trustworthiness of its observations remain separate obligations.

## Non-claims

This experiment does not prove:

- diagnosability of arbitrary or infinite-state provider protocols;
- correctness of the finite abstraction relative to GitHub, Kubernetes, GCP, or another provider;
- wall-clock bounded diagnosis or unbounded fairness properties;
- that ordinary final-state equality proves a particular mutation occurred;
- that a suggested observation is trustworthy merely because it separates two abstract states;
- production readiness of the checker or permission to use it as settlement authority.

## Result

**Supported for the preregistered bounded corpus.** Exact revision `79c666d1aad67ff3c7df894f3cd509d572e4fcce` was evaluated in GitHub Actions Merge gate run `35922140571`, rerun attempt 2, candidate-evidence job `107389085625`.

The hosted checker matched all seven expected classifications:

- `undispatched`, `receipt`, and `bounded-eventual-webhook` were safe-diagnosable;
- `ambiguous-timeout`, `stale-get`, and `same-final-state` were non-diagnosable and each emitted a concrete ambiguity-cycle witness;
- `too-late` was diagnosable but not safe-diagnosable because `release-authority` remained reachable while mutation and non-mutation worlds were still observationally ambiguous.

The independent depth-12 trace oracle agreed with the product checker on all seven fixtures: each non-diagnosable fixture retained one ambiguous observation sequence at depth 12, while every diagnosable fixture retained zero. Collapsing `RECEIPT_PRESENT` and `RECEIPT_ABSENT` into one uncorrelated `RECEIPT` observation made the receipt protocol non-diagnosable, killing the preregistered negative control.

The same exact-head candidate passed repository lint and TypeScript checking, the experiment contract, all maintained deterministic experiments, TLA+, the production computation boundary, and self-application.

This supports the narrow Phase 1 claim that DES-style diagnosability is mechanically useful on a finite effect-protocol abstraction and that safe diagnosability captures a real distinction between eventual knowledge and knowledge available before authority reuse.

**Phase 2 is supported at exact revision `a062eb8827830d3558fabd794bcf3ae9d8d76460`.** GitHub Actions Merge gate run `35923271198`, rerun attempt 2, candidate-evidence job `107392831495`, passed the full exact-head candidate suite. The diagnoser implementation was unchanged from Phase 1.

The three independently frozen GitHub-status slices reproduced the established recovery boundary:

- trusted pre-`secureConnect` `NOT_DISPATCHED` was diagnosable and safe-diagnosable with zero ambiguous pairs, deriving `safe-to-release`;
- post-`secureConnect` reset was non-diagnosable and not safe-diagnosable, retained one depth-12 ambiguous observation sequence, emitted an ambiguity-cycle witness, and derived `ambiguous-do-not-release`;
- HTTP 502 after dispatch had the same non-diagnosable result and likewise derived `ambiguous-do-not-release`.

Both ambiguous GitHub slices identified `release-authority` as reachable while mutation and non-mutation worlds remained observationally indistinguishable. The same exact-head candidate passed lint, TypeScript checking, experiment-contract verification, all maintained deterministic experiments, TLA+, the production computation boundary, and self-application.

This is stronger than the synthetic result alone: the unchanged checker independently recovered a real recovery boundary that had been established by separate transport and production-path experiments. It still does not prove that arbitrary provider adapters can be abstracted soundly, nor does it make the checker production authority.
