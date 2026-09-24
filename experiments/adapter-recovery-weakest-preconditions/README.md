# Adapter recovery weakest preconditions

## Question

Can weakest-precondition calculation derive the conditions for releasing an unresolved effect reservation and for replaying an ambiguous effect from evidence semantics plus adapter guarantees, rather than hand-writing those guards?

## Preregistered hypothesis

For a finite recovery state model, demonic backward reasoning will derive:

~~~
RELEASE:
  current_authority
  AND exact_attempt_binding
  AND adapter_match
  AND not_dispatched_certificate

REPLAY:
  current_authority
  AND exact_attempt_binding
  AND adapter_match
  AND terminal_absence_certificate
  AND replay_protected
~~~

Instantiating those conditions with the current GitHub commit-status adapter must independently reproduce the already-established boundary:

- trusted pre-secureConnect NOT_DISPATCHED evidence permits reservation release;
- post-secureConnect reset does not;
- HTTP 502 does not;
- wrong provider origin, request path, or request body does not;
- authoritative terminal absence does not permit replay because the adapter is may-duplicate and declares replay forbidden.

A synthetic semantically-idempotent adapter with an admitted terminal-absence replay capability is the positive replay control: replay must become safe only when terminal absence is present.

The experiment is falsified if the calculated predicates differ, any omitted-guard mutant fails to expose an unsafe state, GitHub post-secureConnect/502 ambiguity is admitted, GitHub replay becomes safe, or the replayable synthetic control does not distinguish terminal absence.

## State space

The treatment exhausts 64 states over six independent booleans:

- current execution authority;
- exact attempt/reservation binding;
- exact adapter contract/verifier match;
- evidence certifying that dispatch did not occur;
- authoritative terminal-absence evidence;
- provider semantics protecting replay from duplicate delivery.

For RELEASE, absence of a trusted not-dispatched certificate means the hidden prior effect may either have occurred or not occurred. The environment chooses the hostile world.

For REPLAY, the hidden prior effect may have occurred even when the provider is currently absent. Without replay protection that creates a possible duplicate side effect. Without terminal absence, provider state may also still conflict with another dispatch.

## Relationship to existing evidence

This experiment does not re-prove which transport observations are trustworthy. It consumes the boundary already established independently by:

- transport-not-dispatched-evidence;
- github-status-not-dispatched-release;
- adapter-diagnosability.

The production differential checks the post-validation semantic release predicate in effect-adapter.ts against exact GitHub request identity. Provenance minting and one-shot witness consumption remain covered by the earlier transport experiments.

## Production differential

The treatment imports the current GitHub adapter capability descriptor and the production semantic predicates:

- reservedEffectReleaseWitnessSafe();
- reservedEffectReplaySafe().

For an exact GitHub status obligation it checks:

1. exact pre-secureConnect witness accepted;
2. post-secureConnect variant rejected;
3. HTTP 502 represented as no not-dispatched certificate and rejected by the derivation;
4. wrong origin rejected;
5. wrong path rejected;
6. wrong body digest rejected;
7. authoritative absence cannot make GitHub replay safe because duplicate delivery remains may-duplicate and replay capability is forbidden.

## Hostile controls

Four RELEASE guards are independently removed: current authority, exact attempt binding, adapter match, and not-dispatched evidence. Every mutant must admit at least one state outside the calculated safe set.

Five REPLAY guards are independently removed: current authority, exact attempt binding, adapter match, terminal absence, and replay protection. Every mutant must admit at least one unsafe state.

The synthetic replay adapter is then mutated from semantically-idempotent to may-duplicate while retaining terminal-absence replay capability. Production capability validation must reject that combination.

## Reproduce

~~~sh
npm run test:adapter-recovery-weakest-preconditions
~~~

The experiment is deterministic, offline, TypeScript-only, and adds no runtime dependency.

## Acceptance criteria

1. RELEASE derives exactly current_authority AND exact_attempt_binding AND adapter_match AND not_dispatched_certificate.
2. REPLAY derives exactly current_authority AND exact_attempt_binding AND adapter_match AND terminal_absence_certificate AND replay_protected.
3. Every single omitted RELEASE guard admits at least one unsafe witness.
4. Every single omitted REPLAY guard admits at least one unsafe witness.
5. The current GitHub adapter descriptor remains may-duplicate with replay forbidden and not-dispatched reservation release admitted.
6. The production semantic release predicate accepts only the exact preregistered pre-secureConnect GitHub witness among the tested variants.
7. Post-secureConnect reset and HTTP 502 remain outside the derived release predicate.
8. Wrong GitHub origin, status path, and mutation body digest remain outside production semantic release acceptance.
9. Production reservedEffectReplaySafe() rejects authoritative terminal absence for GitHub status.
10. The calculated replay predicate rejects GitHub terminal absence because replay protection is false.
11. The semantically-idempotent synthetic adapter permits replay only with terminal absence.
12. Changing that synthetic adapter to may-duplicate while retaining replay capability is rejected by production capability validation.
13. Exact-head hosted execution passes without changing the preregistered treatment.

## Interpretation boundary

A positive result would show that the narrow GitHub recovery rules can be obtained as consequences of a small declarative adapter contract plus evidence semantics, rather than only as hand-authored special cases.

The important distinction is structural:

~~~
proof of non-dispatch
  -> release old reservation
  -> a new attempt may begin

ambiguous dispatch + terminal absence
  -> replay only if adapter semantics protect duplicates

ambiguous dispatch without either
  -> RECOVERY_REQUIRED
~~~

That would support moving toward generated recovery guards as adapter tooling. It would not yet justify generated production code or treating this finite abstraction as complete.

## Non-claims

This experiment does not prove:

- the transport witness itself is trustworthy; prior experiments establish that boundary;
- the six-boolean abstraction is complete for all recovery state;
- terminal absence implies a prior mutation never happened;
- GitHub commit-status replay is safe;
- liveness or eventual observation availability;
- adapter capability declarations are truthful merely because they are syntactically valid;
- the weakest-precondition calculator should become production authority;
- settlement-to-DONE is derived here; this treatment is deliberately limited to release and replay.

## Result

Pending exact-head hosted execution.
