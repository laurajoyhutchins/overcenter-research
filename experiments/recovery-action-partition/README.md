# Recovery action partition

## Question

Can one bounded weakest-precondition model derive a complete, mutually exclusive recovery decision for an unresolved external effect: SETTLE, RELEASE, REPLAY, or RECOVERY_REQUIRED?

## Preregistered hypothesis

Within an unresolved-effect recovery scope, hostile backward reasoning will derive:

~~~
SETTLE:
  current_authority
  AND exact_attempt_binding
  AND evidence = verified-present

RELEASE:
  current_authority
  AND exact_attempt_binding
  AND adapter_match
  AND evidence = not-dispatched

REPLAY:
  current_authority
  AND exact_attempt_binding
  AND adapter_match
  AND replay_protected
  AND evidence = terminal-absence

RECOVERY_REQUIRED:
  otherwise
~~~

The three affirmative action sets must be pairwise disjoint over the preregistered state space, and the fallback must cover every remaining state.

A key falsifier is that SETTLE must not require adapter match. Production settlement is postcondition-centric: if authoritative observation proves the exact postcondition, the unresolved reservation can settle DONE even when adapter mutation semantics are irrelevant to that proof.

## State space

The experiment exhausts 64 states:

- current authority: yes/no;
- exact attempt binding: yes/no;
- adapter contract/verifier match: yes/no;
- replay protection: yes/no;
- one of four mutually exclusive evidence classes:
  - verified-present;
  - not-dispatched;
  - terminal-absence;
  - ambiguous.

Every state is scoped to an unresolved effect reservation.

Each evidence class constrains hidden reality differently:

- verified-present proves the desired provider state currently exists;
- not-dispatched proves this attempt did not cause an external effect but says nothing about whether the desired state already existed;
- terminal-absence proves the desired provider state is currently absent but does not prove a previous mutation never happened;
- ambiguous proves neither occurrence nor current desired state.

The environment chooses every hidden world still consistent with the evidence. An action is admitted only if it is safe in all such worlds.

## Safety postconditions

SETTLE is safe only when current authority and exact attempt binding hold and the desired provider state is true in every hidden world.

RELEASE is safe only when current authority, exact attempt binding, and adapter match hold and the prior attempt is known not to have occurred.

REPLAY is safe only when current authority, exact attempt binding, and adapter match hold, current provider state is authoritatively absent, and duplicate delivery is protected if a prior mutation may have occurred.

RECOVERY_REQUIRED performs no external mutation and is the conservative fallback.

## Production differential

The experiment imports current production machinery and checks:

- observationVerified() accepts an exact GitHub desired-state observation and rejects a wrong state;
- projectReceipt(..., unresolvedEffect=true) settles the verified observation DONE;
- the same verified observation still settles DONE if packet effect_contract is changed to an unregistered adapter, demonstrating that settlement is postcondition-centric rather than adapter-centric;
- an unresolved wrong-state GitHub observation remains RECOVERY_REQUIRED;
- the existing exact pre-secureConnect GitHub witness remains semantically valid for release;
- the current GitHub adapter remains replay-forbidden, so terminal absence maps to RECOVERY_REQUIRED rather than REPLAY;
- a replay-protected terminal-absence control maps to REPLAY.

## Hostile controls

Two evidence-collapse mutants deliberately blur distinctions the calculus is meant to preserve:

1. treat verified-present as if it also proved not-dispatched;
2. treat terminal-absence as if it proved not-dispatched.

Each must admit states outside the derived RELEASE safe set.

A separate gap control removes RECOVERY_REQUIRED and must leave at least one preregistered state without any action.

## Acceptance criteria

1. SETTLE derives exactly current_authority AND exact_attempt_binding AND evidence=verified-present.
2. RELEASE derives exactly current_authority AND exact_attempt_binding AND adapter_match AND evidence=not-dispatched.
3. REPLAY derives exactly current_authority AND exact_attempt_binding AND adapter_match AND replay_protected AND evidence=terminal-absence.
4. The SETTLE, RELEASE, and REPLAY safe sets are pairwise disjoint.
5. Adding RECOVERY_REQUIRED as the fallback yields exactly one action for all 64 states.
6. At least one state requires RECOVERY_REQUIRED.
7. SETTLE remains admissible when adapter_match=false if authority, binding, and verified-present evidence hold.
8. Misclassifying verified-present as not-dispatched admits unsafe RELEASE states.
9. Misclassifying terminal-absence as not-dispatched admits unsafe RELEASE states.
10. Removing the recovery fallback leaves states unclassified.
11. Production observationVerified() accepts the exact GitHub desired state and rejects a wrong state.
12. Production projectReceipt() settles a verified observation DONE despite an unresolved reservation.
13. Production projectReceipt() also settles DONE when the packet effect adapter is mismatched, confirming adapter independence of verified settlement.
14. Production projectReceipt() leaves an unresolved wrong-state GitHub observation RECOVERY_REQUIRED.
15. The exact pre-secureConnect GitHub release witness remains accepted by the production semantic release predicate.
16. GitHub terminal absence maps to RECOVERY_REQUIRED under the current replay-forbidden adapter.
17. A replay-protected terminal-absence control maps to REPLAY.
18. Exact-head hosted execution passes without modifying the preregistered treatment.

## Interpretation boundary

A positive result would close the small recovery-decision loop:

~~~
trusted evidence
+ current authority
+ exact attempt identity
+ adapter semantics
        ↓
derive one action
        ↓
SETTLE | RELEASE | REPLAY | RECOVERY_REQUIRED
~~~

It would also establish a useful separation of concerns: verification evidence controls SETTLE; transport non-occurrence evidence controls RELEASE; authoritative absence plus duplicate-safe adapter semantics controls REPLAY.

## Non-claims

This experiment does not prove:

- that the four evidence classes cover every future provider protocol;
- that evidence from different times may be freely combined;
- liveness or eventual recovery;
- transport-witness provenance, which prior experiments cover;
- adapter capability declarations are truthful without independent evidence;
- the finite calculator should become production authority;
- generated code is preferable to reviewed predicates;
- RECOVERY_REQUIRED can always be resolved automatically.

## Reproduce

~~~sh
npm run test:recovery-action-partition
~~~

The experiment is deterministic, offline, TypeScript-only, and adds no runtime dependency.

## Result

**Supported for the preregistered bounded treatment.** Exact revision `e62739adf3e4764167762de3e1350a5deb0b322d` was evaluated in GitHub Actions Merge gate run `35955935794`, rerun attempt 2, exact-head candidate job `107497573082`.

The 64-state unresolved-effect model derived exactly:

~~~
SETTLE = current_authority
         AND exact_attempt_binding
         AND evidence = verified-present

RELEASE = current_authority
          AND exact_attempt_binding
          AND adapter_match
          AND evidence = not-dispatched

REPLAY = current_authority
         AND exact_attempt_binding
         AND adapter_match
         AND replay_protected
         AND evidence = terminal-absence

RECOVERY_REQUIRED = otherwise
~~~

The resulting partition was total and disjoint:

- SETTLE: 4 states
- RELEASE: 2 states
- REPLAY: 1 state
- RECOVERY_REQUIRED: 57 states
- safe-action overlap: 0 states

The hostile controls behaved as required. Treating verified-present as proof of non-dispatch admitted 2 unsafe RELEASE states. Treating terminal absence as proof of non-dispatch admitted another 2 unsafe RELEASE states. Removing the RECOVERY_REQUIRED fallback left all 57 conservative states unclassified.

The production differential confirmed the important separation:

- exact desired-state observation verified successfully;
- a verified observation settled DONE even with an unresolved reservation;
- the same verified observation still settled DONE when the packet effect adapter was deliberately changed to an unregistered value;
- a wrong-state GitHub observation with an unresolved effect stayed RECOVERY_REQUIRED;
- the exact pre-secureConnect GitHub witness remained accepted for RELEASE;
- current GitHub terminal absence mapped to RECOVERY_REQUIRED because replay remains forbidden;
- the replay-protected terminal-absence control mapped to REPLAY.

The exact-head candidate also passed the complete deterministic experiment suite, TLA+, the production computation boundary, and self-application.

The central result is that verified settlement belongs to the postcondition/evidence layer, while RELEASE and REPLAY additionally depend on mutation-adapter semantics. Those responsibilities can therefore be composed into one deterministic recovery decision without conflating them.
