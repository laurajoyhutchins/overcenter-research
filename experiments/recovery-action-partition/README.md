# Recovery action partition

## Question

Can Overcenter derive a safe recovery action from current execution authority, exact claim identity, unresolved-reservation identity, current provider observation, trusted transport evidence, and adapter semantics without collapsing distinct temporal coordinates?

## Review correction

The first treatment at `e62739adf3e4764167762de3e1350a5deb0b322d` was useful but insufficient for promotion. Review found three problems:

1. one evidence enum made disjointness true partly by construction;
2. one `exact_attempt_binding` bit collapsed current execution authority/revision with unresolved reservation identity, contradicting the earlier two-clock necessity result;
3. totality was asserted by an unconditional `RECOVERY_REQUIRED` fallback rather than checked against an independently derived safe-action set.

That treatment is superseded for the complete-partition claim. This revised treatment keeps its useful production observations but does not use its zero-overlap result as evidence.

## Revised state model

Every state is scoped to one unresolved external-effect reservation.

The model exhausts 256 states over:

- current execution authority: yes/no;
- exact claim/revision identity: yes/no;
- exact unresolved-reservation binding: yes/no;
- adapter contract/verifier match: yes/no;
- replay duplicate protection: yes/no;
- trusted NOT_DISPATCHED evidence: yes/no;
- current normalized provider observation: verified-present, terminal-absence, ambiguous, or none.

The provider observation is the current authoritative resolution observation, not the entire evidence history. Historical provider observations may coexist in durable history; normalization selects the observation authoritative for this resolution attempt, while attempt-bound transport evidence remains an independent fact. If current provider state cannot be established coherently, it is `ambiguous`.

This permits the overlaps erased by the original enum. NOT_DISPATCHED may coexist with a verified current desired state or with current terminal absence.

## Hidden worlds

Trusted evidence restricts hidden reality:

- NOT_DISPATCHED proves the unresolved attempt did not cause an external effect;
- verified-present proves the desired provider state currently exists;
- terminal-absence proves the desired provider state is currently absent;
- ambiguous/none leave current desired state unknown.

Every hidden world consistent with those facts is adversarially considered. An affirmative action is safe only if its safety postcondition holds in all such worlds.

## Safety postconditions

### SETTLE

SETTLE requires current execution authority, exact claim/revision identity, and current provider state satisfying the postcondition. It does not require reservation binding or adapter match. Settlement is postcondition-centric.

### RELEASE

RELEASE requires current execution authority, exact claim/revision identity, exact unresolved-reservation binding, matching adapter semantics, and trusted proof that this attempt did not dispatch.

### REPLAY

REPLAY requires current execution authority, exact claim/revision identity, matching adapter semantics, duplicate-safe replay semantics, and current authoritative terminal absence. It does not require the current execution-authority epoch to equal the unresolved reservation's original epoch.

## Safe-action set and precedence

The experiment first derives the complete set of safe affirmative actions independently from hidden-world semantics. Only after that does policy choose one action using explicit precedence:

~~~
SETTLE > RELEASE > REPLAY > RECOVERY_REQUIRED
~~~

The precedence is deliberate: settle an already-satisfied postcondition; otherwise prefer exact non-dispatch release over duplicate-safe replay; otherwise replay only when terminal absence and adapter semantics establish safety; choose RECOVERY_REQUIRED only when no affirmative action is safe.

Unlike the superseded treatment, overlap is expected and tested rather than excluded by representation.

## Preregistered hypotheses

~~~
SETTLE =
  current_authority
  AND exact_revision
  AND provider_observation = verified-present

RELEASE =
  current_authority
  AND exact_revision
  AND reservation_binding
  AND adapter_match
  AND not_dispatched

REPLAY =
  current_authority
  AND exact_revision
  AND adapter_match
  AND replay_protected
  AND provider_observation = terminal-absence
~~~

The model must contain a SETTLE + RELEASE overlap resolved to SETTLE, a RELEASE + REPLAY overlap resolved to RELEASE, a successor-authority state where reservation binding is false but REPLAY remains safe, and conservative states with no affirmative safe action.

## Production differential

The treatment checks current production machinery directly:

- `observationVerified()` accepts exact desired GitHub state and rejects a wrong state;
- `projectReceipt(..., unresolvedEffect=true)` settles verified state DONE;
- verified settlement remains DONE when packet effect adapter is deliberately mismatched;
- wrong-state GitHub observation with unresolved effect remains RECOVERY_REQUIRED;
- exact pre-`secureConnect` GitHub witness remains accepted for RELEASE;
- current GitHub adapter remains replay-forbidden.

It also executes an end-to-end two-clock settlement through `OvercenterKernel`: claim work, reserve an effect under generation 1, rotate execution authority while the reservation remains unresolved, reject the stale predecessor permit, reject a successor permit with the wrong claimed revision, then settle DONE under the valid successor authority and durably clear the older unresolved reservation.

## Hostile controls

The revised treatment requires all of these to fail or overconstrain:

- RELEASE without exact reservation binding;
- treating verified-present as proof of non-dispatch;
- treating terminal absence as proof of non-dispatch;
- requiring reservation binding for SETTLE;
- requiring reservation binding for REPLAY;
- SETTLE without exact revision.

The reservation-binding overconstraint controls explicitly defend the earlier result that execution authority and unresolved mutation identity have different lifetimes.

## Acceptance criteria

1. The full revised state space contains 256 states.
2. SETTLE derives exactly `current_authority && exact_revision && provider_observation=verified-present`.
3. RELEASE derives exactly `current_authority && exact_revision && reservation_binding && adapter_match && not_dispatched`.
4. REPLAY derives exactly `current_authority && exact_revision && adapter_match && replay_protected && provider_observation=terminal-absence`.
5. The independently derived safe-action sets contain real overlaps.
6. Every affirmative chosen action belongs to the independently derived safe-action set.
7. RECOVERY_REQUIRED is chosen if and only if the safe-action set is empty.
8. SETTLE wins every SETTLE + RELEASE overlap.
9. RELEASE wins every RELEASE + REPLAY overlap.
10. Omitting reservation binding admits unsafe RELEASE states.
11. Evidence-collapse mutants admit unsafe RELEASE states.
12. Requiring reservation binding for SETTLE rejects safe states.
13. Requiring reservation binding for REPLAY rejects safe successor-authority states.
14. Omitting exact revision admits unsafe SETTLE states.
15. Production verified settlement remains DONE with an unresolved reservation and without adapter dependence.
16. Production wrong-state observation remains RECOVERY_REQUIRED.
17. Exact pre-`secureConnect` GitHub release evidence remains admitted.
18. End-to-end stale predecessor authority is rejected after execution-authority rotation.
19. End-to-end wrong claimed revision is rejected under the successor authority.
20. The valid successor authority settles DONE while reconciling an older unresolved reservation and clears that reservation durably.
21. Exact-head hosted execution passes without changing the preregistered treatment.

## Interpretation boundary

~~~
current execution authority + exact claim revision
                        |
current provider observation
                        |
trusted transport evidence + reservation identity
                        |
adapter replay/release semantics
                        v
               derive safe action set
                        v
       explicit deterministic precedence
                        v
SETTLE | RELEASE | REPLAY | RECOVERY_REQUIRED
~~~

The important separation is temporal as well as semantic: execution authority may rotate, mutation reservation may persist, and provider truth is observed independently.

## Non-claims

This experiment does not prove:

- that the provider-observation classes cover every future protocol;
- that arbitrary historical observations may be combined without normalization;
- liveness or eventual recovery;
- transport-witness provenance, which prior experiments cover;
- adapter declarations are truthful without independent evidence;
- the finite calculator should become production authority;
- this precedence is the only safe precedence;
- RECOVERY_REQUIRED can always be resolved automatically;
- the bounded positive-conjunction vocabulary is a general symbolic weakest-precondition engine.

## Reproduce

~~~sh
npm run test:recovery-action-partition
~~~

The experiment is deterministic, offline, TypeScript-only, and adds no runtime dependency.

## Result

Pending exact-head hosted execution of the revised treatment. The prior result at `e62739adf3e4764167762de3e1350a5deb0b322d` is superseded for the complete-partition claim.
