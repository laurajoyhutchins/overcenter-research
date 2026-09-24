# Weakest-precondition admission

## Question

Can a bounded weakest-precondition calculation derive the current Overcenter mutation-admission condition from an independently stated safety postcondition, while also detecting both missing guards and unnecessary ceremony?

## Preregistered hypothesis

For the finite treatment below, universal backward reasoning over hostile outcomes will derive exactly:

~~~
current_authority
AND exact_revision
AND NOT unresolved_effect
~~~

The calculated predicate will be extensionally equal to the production mutationAdmitted() predicate on every preregistered initial state. Removing any one production guard must admit at least one state rejected by the calculated predicate. Adding a safety-irrelevant ceremony token must reject at least one state accepted by the calculated predicate without admitting an unsafe state.

Two protocol mutants are required to have no safe initial state under the same postcondition:

1. an effect may be dispatched and the process may crash before durable reservation;
2. an ambiguous first dispatch may be blindly replayed.

The experiment is falsified if any of those conditions fail.

## State space

The finite initial state is the Cartesian product of four booleans:

- current execution authority;
- exact claimed revision;
- an already unresolved prior effect;
- a synthetic ceremony token deliberately irrelevant to safety.

That gives 16 initial states.

The correct protocol has four hostile outcomes per initial state:

- definitely not dispatched;
- committed and observed;
- committed but observationally ambiguous;
- not committed but observationally ambiguous.

The environment is demonic for this experiment: an initial state belongs to the weakest precondition only when every permitted outcome satisfies the postcondition.

## Independent safety postcondition

The safety predicate is stated separately from production admission. It requires:

1. every newly occurring external effect has current authority;
2. every newly occurring external effect is bound to the exact claimed revision;
3. the prior unresolved effect count plus newly occurring effects is at most one;
4. every ambiguous outcome is already durably represented by a reservation that precedes the uncertainty.

The synthetic ceremony token is absent from the safety predicate.

## Treatments and controls

The baseline calculates the complete set of safe initial states, minimizes that truth set to a conjunction of literals, and compares the resulting set against the real production mutationAdmitted() function imported from src/authority/transaction-admission.ts.

Three hostile guard mutants independently omit current authority, exact revision, or unresolved-effect exclusion. Each must admit an explicit unsafe witness.

A deliberately overstrict guard adds the synthetic ceremony token. It must admit no unsafe state but reject a state in the calculated weakest precondition, demonstrating detection of unnecessary ceremony.

Three specification-sensitivity controls remove one safety clause at a time. The derived weakest condition must weaken in the corresponding dimension rather than continuing to reproduce the production guard by construction.

Finally, two protocol mutants exercise ordering and replay:

- dispatch-before-reservation includes a crash immediately after dispatch and before reservation;
- blind-replay permits a second dispatch after ambiguity.

Both must calculate to false, meaning no initial state can make that protocol satisfy the stated safety property against all hostile outcomes.

## Acceptance criteria

The experiment is supported only if all of the following hold:

1. the calculated weakest condition is current_authority AND exact_revision AND NOT unresolved_effect, independent of the ceremony token;
2. production mutationAdmitted() is extensionally identical to that condition over all 16 initial states;
3. each single missing-guard mutant admits at least one unsafe witness;
4. the synthetic ceremony guard rejects at least one calculated-safe state and admits no calculated-unsafe state;
5. removing authorization from the postcondition removes current_authority from the derived condition;
6. removing exact-revision binding from the postcondition removes exact_revision from the derived condition;
7. removing at-most-once from the postcondition removes unresolved-effect exclusion from the derived condition;
8. dispatch-before-reservation has an empty weakest precondition;
9. blind replay after ambiguity has an empty weakest precondition;
10. the experiment is deterministic, offline, TypeScript-only, and adds no runtime dependency.

## Reproduce

~~~sh
npm run test:weakest-precondition-admission
~~~

The experiment is also registered as deterministic, so it runs under the maintained deterministic experiment suite.

## Interpretation boundary

A positive result would show, for this bounded mutation-admission slice, that the present production guard is not merely sufficient: it is exactly the weakest conjunction needed by the stated safety property in the modeled state space. The missing-guard and ceremony controls distinguish underconstraint from overconstraint, while the protocol mutants show that some safety failures cannot be repaired by strengthening admission alone.

This would justify a second experiment over a richer effect protocol, especially derivation of reservation-release and replay guards from adapter semantics. It would not yet justify making a weakest-precondition engine production authority.

## Non-claims

This experiment does not prove:

- completeness of the four-boolean state abstraction for the entire Overcenter kernel;
- correctness of authorizeEffect(), adapter contract matching, provider identity, settlement, or graph admission;
- liveness, eventual diagnosability, or provider availability;
- that arbitrary TypeScript can be reduced to a useful symbolic weakest precondition;
- that the current production guard remains minimal after the safety specification or protocol changes;
- that a generated admission predicate should replace reviewed production code.

## Result

Pending exact-head hosted execution.
