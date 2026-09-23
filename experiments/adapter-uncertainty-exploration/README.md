# Adapter uncertainty exploration

## Question

Does Overcenter's current durable GitHub commit-status state vocabulary preserve every distinction that matters to retry safety across uncertainty at the provider boundary?

The motivating distinction is deliberately narrow:

```text
reserved, request definitely never dispatched
                versus
reserved, request dispatched and committed but readback still hides it
```

The first physical world is safe to retry. The second is not. If both reconstruct to the same durable recovery state, the current representation is safe but unnecessarily loses liveness information.

## Preregistered hypothesis

The current `effect reservation + observation + receipt` vocabulary is sufficient to distinguish materially different mutation-certainty states reachable at the admitted GitHub commit-status boundary.

A counterexample falsifies that hypothesis if two modeled physical worlds:

1. require different safe retry decisions;
2. execute the real production `performGithubCommitStatusEffect` and SQLite kernel;
3. produce the same durable recovery fingerprint after worker loss and fresh reconstruction.

## Treatment

This is the bounded enumerative precursor to full concolic execution.

The production adapter and kernel remain concrete. Only uncertainty at the injected provider boundary varies:

- dispatch: not started or completed;
- remote effect: absent or present, subject to dispatch constraints;
- response: transport throw, HTTP 502, or HTTP 201;
- readback visibility: hidden or visible when an effect exists.

Ten reachable worlds are exhausted. Each world is run through reservation, the production provider adapter, fresh-kernel execution-authority rotation, duplicate-retry attempt, interruption recovery, authoritative GitHub readback semantics, and settlement.

The durable fingerprint intentionally excludes the transient exception string and physical ground truth. It includes only information that survives into Overcenter authority:

- unresolved reservation state;
- whether a second mutation was blocked;
- interruption disposition;
- reconciliation disposition;
- final project status;
- receipt kind, disposition, verification result, mutation certainty, and observation error.

## Negative controls

The world set must kill three deliberately unsafe policies:

1. retry every transport throw;
2. retry every `RECOVERY_REQUIRED` result;
3. treat HTTP 201 as DONE without authoritative readback.

If these survive, the explorer is not sensitive enough to support a conclusion.

## Reproduce

```sh
npm run test:adapter-uncertainty-exploration
```

No network or GitHub credential is required. Provider transport and visibility are injected, while the production adapter, production SQLite authority path, production GitHub observation grammar, and production settlement logic execute unchanged.

## Acceptance criteria

The experiment is informative only if:

1. every declared reachable world executes successfully through the harness;
2. production never performs a blind second POST while an unresolved reservation exists;
3. production never reaches DONE without a visible matching authoritative status;
4. all three unsafe negative-control policies are killed;
5. the preregistered pair is compared exactly:
   - `connect-fails-before-dispatch`, physically retry-safe;
   - `dispatch-present-throw-hidden`, physically retry-unsafe;
6. the hypothesis is falsified only if that pair has the same durable recovery fingerprint.

## Interpretation

A falsifying witness would not be a safety bug. The existing reservation rule should still prevent duplicate mutation. It would show a knowledge/liveness loss: Overcenter cannot durably retain a proof that a reserved effect never crossed the dispatch boundary, so recovery must conservatively treat that case like a possibly committed effect.

That would motivate an explicit dispatch-certainty fact or equivalent evidence, but only if such evidence can itself be made trustworthy.

If the hypothesis survives, the next step is to expand the uncertainty grammar before introducing an SMT solver. If bounded enumeration already exposes the useful paths, full symbolic execution has not yet earned its complexity.

## Non-claims

This experiment does not prove:

- correctness of arbitrary provider adapters;
- that Node `fetch` can always prove whether zero request bytes were dispatched;
- that HTTP 502 or transport exceptions imply provider absence;
- real GitHub timing, proxy, webhook, or eventual-consistency distributions;
- full symbolic execution, solver-guided path generation, or branch-coverage completeness;
- that a newly proposed dispatch-certainty state would be trustworthy enough for automatic replay.

## Result

**Falsified.** Exact revision `c4c3564bb02618642fcb9d046686772f7adb8224` was evaluated in GitHub Actions Merge gate run `35822437473`, rerun attempt 2, candidate-evidence job `107057254622`.

The explorer exhausted all 10 declared reachable worlds. They collapsed to 2 durable equivalence classes, with 1 class containing worlds that require different physical retry decisions.

The preregistered counterexample was observed exactly:

- retry-safe physical world: `connect-fails-before-dispatch`;
- retry-unsafe physical world: `dispatch-present-throw-hidden`;
- both retained an unresolved reservation, blocked a second provider POST, recorded interruption as `RECOVERY_REQUIRED`, reconciled to `RECOVERY_REQUIRED`, and finished with project status `RECOVERY_REQUIRED`;
- authoritative GitHub readback reported `mutation_certainty: uncertain` with `COLLECTION_ABSENCE_NOT_AUTHORITATIVE` in both worlds.

Production safety held throughout the bounded corpus: no blind second mutation was observed and no world reached DONE without a visible matching remote effect. All three negative controls were killed: retry-on-any-throw, retry-on-`RECOVERY_REQUIRED`, and trust-HTTP-201-without-readback.

This falsifies the preregistered sufficiency hypothesis. The current durable vocabulary intentionally preserves safety by collapsing a definitely-not-dispatched effect into the same conservative recovery state as a possibly committed but not yet visible effect. The missing distinction is therefore a knowledge/liveness opportunity, not an observed safety defect.

The first attempted execution at `709b0b5d345744e7aa7e5c8f7e5a45ad6112bf76` was discarded before interpretation because the test fixture over-escaped the `?` in the paginated status-read path and caused the stub itself to reject the production request. Revision `c4c3564bb02618642fcb9d046686772f7adb8224` changed only that fixture path assertion; the preregistered question, world grammar, witness pair, durable fingerprint, safety invariants, and negative controls were unchanged.
