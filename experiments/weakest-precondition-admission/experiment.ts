import assert from 'node:assert/strict';

import { mutationAdmitted } from '../../src/authority/transaction-admission.ts';

interface InitialState {
  current_authority: boolean;
  exact_revision: boolean;
  unresolved_effect: boolean;
  ceremony_token: boolean;
}

interface Outcome {
  name: string;
  new_effects: number;
  ambiguous: boolean;
  reservation_precedes_uncertainty: boolean;
}

type Clause = 'authorized' | 'exact-revision' | 'at-most-once' | 'durable-ambiguity';
type Protocol = (initial: InitialState) => readonly Outcome[];
type Predicate = (initial: InitialState, outcome: Outcome) => boolean;

const bools = [false, true] as const;
const states: InitialState[] = [];
for (const current_authority of bools) {
  for (const exact_revision of bools) {
    for (const unresolved_effect of bools) {
      for (const ceremony_token of bools) {
        states.push({
          current_authority,
          exact_revision,
          unresolved_effect,
          ceremony_token,
        });
      }
    }
  }
}

const key = (state: InitialState): string =>
  [
    state.current_authority ? 'A1' : 'A0',
    state.exact_revision ? 'R1' : 'R0',
    state.unresolved_effect ? 'U1' : 'U0',
    state.ceremony_token ? 'C1' : 'C0',
  ].join(':');

const correctProtocol: Protocol = () => [
  {
    name: 'not-dispatched',
    new_effects: 0,
    ambiguous: false,
    reservation_precedes_uncertainty: true,
  },
  {
    name: 'committed-observed',
    new_effects: 1,
    ambiguous: false,
    reservation_precedes_uncertainty: true,
  },
  {
    name: 'committed-ambiguous',
    new_effects: 1,
    ambiguous: true,
    reservation_precedes_uncertainty: true,
  },
  {
    name: 'not-committed-ambiguous',
    new_effects: 0,
    ambiguous: true,
    reservation_precedes_uncertainty: true,
  },
];

const dispatchBeforeReservation: Protocol = (initial) => [
  {
    name: 'crash-after-dispatch-before-reservation',
    new_effects: 1,
    ambiguous: true,
    reservation_precedes_uncertainty: false,
  },
  ...correctProtocol(initial),
];

const blindReplay: Protocol = (initial) => [
  ...correctProtocol(initial),
  {
    name: 'ambiguous-then-replay',
    new_effects: 2,
    ambiguous: true,
    reservation_precedes_uncertainty: true,
  },
];

function safetyPredicate(omitted: ReadonlySet<Clause> = new Set()): Predicate {
  return (initial, outcome) => {
    const clauses: Record<Clause, boolean> = {
      authorized: outcome.new_effects === 0 || initial.current_authority,
      'exact-revision': outcome.new_effects === 0 || initial.exact_revision,
      'at-most-once':
        (initial.unresolved_effect ? 1 : 0) + outcome.new_effects <= 1,
      'durable-ambiguity':
        !outcome.ambiguous || outcome.reservation_precedes_uncertainty,
    };
    return (Object.entries(clauses) as [Clause, boolean][]).every(
      ([name, holds]) => omitted.has(name) || holds,
    );
  };
}

function weakestPrecondition(protocol: Protocol, postcondition: Predicate): InitialState[] {
  return states.filter((initial) =>
    protocol(initial).every((outcome) => postcondition(initial, outcome)),
  );
}

const variables = [
  'current_authority',
  'exact_revision',
  'unresolved_effect',
  'ceremony_token',
] as const satisfies readonly (keyof InitialState)[];
type Choice = -1 | 0 | 1;

function deriveConjunction(selected: readonly InitialState[]): string {
  const target = new Set(selected.map(key));
  if (target.size === 0) return 'false';

  const choices: readonly Choice[] = [-1, 0, 1];
  const matches: string[][] = [];
  for (const a of choices) {
    for (const b of choices) {
      for (const c of choices) {
        for (const d of choices) {
          const vector: readonly Choice[] = [a, b, c, d];
          const accepted = states.filter((state) =>
            variables.every((variable, index) => {
              const choice = vector[index]!;
              return choice === 0 || state[variable] === (choice === 1);
            }),
          );
          if (
            accepted.length === target.size &&
            accepted.every((state) => target.has(key(state)))
          ) {
            matches.push(
              variables.flatMap((variable, index) => {
                const choice = vector[index]!;
                if (choice === 0) return [];
                return [choice === 1 ? variable : '!' + variable];
              }),
            );
          }
        }
      }
    }
  }

  assert.ok(matches.length > 0, 'target is not representable as a conjunction of literals');
  matches.sort((left, right) => left.length - right.length || left.join(' && ').localeCompare(right.join(' && ')));
  return matches[0]!.join(' && ');
}

function productionGuard(state: InitialState): boolean {
  return mutationAdmitted({
    current_authority: state.current_authority,
    exact_revision: state.exact_revision,
    unresolved_effect: state.unresolved_effect,
  });
}

const baseline = weakestPrecondition(correctProtocol, safetyPredicate());
const baselineKeys = new Set(baseline.map(key));
const baselineFormula = deriveConjunction(baseline);

assert.equal(
  baselineFormula,
  'current_authority && exact_revision && !unresolved_effect',
  'derived weakest precondition changed',
);

const productionAccepted = states.filter(productionGuard);
assert.deepEqual(
  productionAccepted.map(key),
  baseline.map(key),
  'production mutation admission differs from the derived weakest precondition',
);

const guardMutants = {
  missing_current_authority: (state: InitialState) =>
    state.exact_revision && !state.unresolved_effect,
  missing_exact_revision: (state: InitialState) =>
    state.current_authority && !state.unresolved_effect,
  missing_unresolved_effect: (state: InitialState) =>
    state.current_authority && state.exact_revision,
};

const guardMutantResults: Record<string, { unsafe_admitted: string[] }> = {};
for (const [name, guard] of Object.entries(guardMutants)) {
  const unsafe = states.filter((state) => guard(state) && !baselineKeys.has(key(state)));
  assert.ok(unsafe.length > 0, name + ' did not expose an unsafe admitted state');
  guardMutantResults[name] = { unsafe_admitted: unsafe.map(key) };
}

const overstrictGuard = (state: InitialState): boolean =>
  productionGuard(state) && state.ceremony_token;
const overstrictUnsafe = states.filter(
  (state) => overstrictGuard(state) && !baselineKeys.has(key(state)),
);
const overstrictRejectedSafe = baseline.filter((state) => !overstrictGuard(state));
assert.equal(overstrictUnsafe.length, 0, 'synthetic ceremony admitted an unsafe state');
assert.ok(
  overstrictRejectedSafe.length > 0,
  'synthetic ceremony failed to reject a state proved safe by the weakest precondition',
);

const weakenedPostconditions = {
  without_authorized: safetyPredicate(new Set<Clause>(['authorized'])),
  without_exact_revision: safetyPredicate(new Set<Clause>(['exact-revision'])),
  without_at_most_once: safetyPredicate(new Set<Clause>(['at-most-once'])),
};

const weakenedResults: Record<string, string> = {};
for (const [name, predicate] of Object.entries(weakenedPostconditions)) {
  weakenedResults[name] = deriveConjunction(weakestPrecondition(correctProtocol, predicate));
}
assert.equal(weakenedResults.without_authorized, 'exact_revision && !unresolved_effect');
assert.equal(weakenedResults.without_exact_revision, 'current_authority && !unresolved_effect');
assert.equal(weakenedResults.without_at_most_once, 'current_authority && exact_revision');

const protocolMutants = {
  dispatch_before_reservation: dispatchBeforeReservation,
  blind_replay: blindReplay,
};
const protocolMutantResults: Record<string, { safe_initial_states: number }> = {};
for (const [name, protocol] of Object.entries(protocolMutants)) {
  const derived = weakestPrecondition(protocol, safetyPredicate());
  assert.equal(
    derived.length,
    0,
    name + ' unexpectedly retained a safe initial state',
  );
  protocolMutantResults[name] = { safe_initial_states: derived.length };
}

const result = {
  state_space: states.length,
  outcomes_per_baseline_state: correctProtocol(states[0]!).length,
  weakest_precondition: baselineFormula,
  weakest_precondition_states: baseline.map(key),
  production_equivalence: {
    accepted_states: productionAccepted.length,
    mismatches: states.filter(
      (state) => productionGuard(state) !== baselineKeys.has(key(state)),
    ).length,
  },
  missing_guard_controls: guardMutantResults,
  unnecessary_ceremony_control: {
    unsafe_admitted: overstrictUnsafe.map(key),
    safe_rejected: overstrictRejectedSafe.map(key),
  },
  specification_sensitivity: weakenedResults,
  protocol_mutants: protocolMutantResults,
};

console.log('weakest-precondition admission experiment: SUPPORTED');
console.log(JSON.stringify(result, null, 2));
