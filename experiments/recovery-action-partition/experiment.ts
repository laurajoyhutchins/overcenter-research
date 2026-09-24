import assert from 'node:assert/strict';

import {
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION,
  GITHUB_STATUS_PROVIDER_ORIGIN,
  effectAdapterCapabilities,
  reservedEffectReleaseWitnessSafe,
} from '../../src/effect-adapter.ts';
import type { ValidatedEffectReleaseWitness } from '../../src/effect-release-witness.ts';
import { canonicalDigest } from '../../src/digest.ts';
import type { Observation } from '../../src/model.ts';
import { observationVerified } from '../../src/observation/observe.ts';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../../src/authority/facts.ts';
import { projectReceipt } from '../../src/authority/replay.ts';

type Evidence = 'verified-present' | 'not-dispatched' | 'terminal-absence' | 'ambiguous';

type Action = 'SETTLE' | 'RELEASE' | 'REPLAY' | 'RECOVERY_REQUIRED';

interface State {
  current_authority: boolean;
  exact_attempt_binding: boolean;
  adapter_match: boolean;
  replay_protected: boolean;
  evidence: Evidence;
}

interface HiddenOutcome {
  prior_effect_occurred: boolean;
  provider_desired_present: boolean;
}

const bools = [false, true] as const;
const evidenceModes = [
  'verified-present',
  'not-dispatched',
  'terminal-absence',
  'ambiguous',
] as const satisfies readonly Evidence[];

const states: State[] = [];
for (const current_authority of bools) {
  for (const exact_attempt_binding of bools) {
    for (const adapter_match of bools) {
      for (const replay_protected of bools) {
        for (const evidence of evidenceModes) {
          states.push({
            current_authority,
            exact_attempt_binding,
            adapter_match,
            replay_protected,
            evidence,
          });
        }
      }
    }
  }
}

const stateKey = (state: State): string =>
  [
    state.current_authority ? 'A1' : 'A0',
    state.exact_attempt_binding ? 'B1' : 'B0',
    state.adapter_match ? 'M1' : 'M0',
    state.replay_protected ? 'P1' : 'P0',
    state.evidence,
  ].join(':');

function hiddenOutcomes(state: State): HiddenOutcome[] {
  const prior = state.evidence === 'not-dispatched' ? ([false] as const) : ([false, true] as const);
  const present =
    state.evidence === 'verified-present'
      ? ([true] as const)
      : state.evidence === 'terminal-absence'
        ? ([false] as const)
        : ([false, true] as const);

  return prior.flatMap((prior_effect_occurred) =>
    present.map((provider_desired_present) => ({
      prior_effect_occurred,
      provider_desired_present,
    })),
  );
}

function safe(action: Exclude<Action, 'RECOVERY_REQUIRED'>, state: State, outcome: HiddenOutcome) {
  if (!state.current_authority || !state.exact_attempt_binding) return false;

  if (action === 'SETTLE') {
    return outcome.provider_desired_present;
  }

  if (!state.adapter_match) return false;

  if (action === 'RELEASE') {
    return !outcome.prior_effect_occurred;
  }

  return (
    !outcome.provider_desired_present && (state.replay_protected || !outcome.prior_effect_occurred)
  );
}

function weakestPrecondition(action: Exclude<Action, 'RECOVERY_REQUIRED'>): State[] {
  return states.filter((state) =>
    hiddenOutcomes(state).every((outcome) => safe(action, state, outcome)),
  );
}

const atomicPredicates = [
  ['current_authority', (state: State) => state.current_authority],
  ['exact_attempt_binding', (state: State) => state.exact_attempt_binding],
  ['adapter_match', (state: State) => state.adapter_match],
  ['replay_protected', (state: State) => state.replay_protected],
  ['evidence=verified-present', (state: State) => state.evidence === 'verified-present'],
  ['evidence=not-dispatched', (state: State) => state.evidence === 'not-dispatched'],
  ['evidence=terminal-absence', (state: State) => state.evidence === 'terminal-absence'],
] as const;

function derivePositiveConjunction(selected: readonly State[]): string {
  const target = new Set(selected.map(stateKey));
  const candidates: { names: string[]; states: State[] }[] = [];
  const count = atomicPredicates.length;

  for (let mask = 0; mask < 1 << count; mask += 1) {
    const chosen = atomicPredicates.filter((_, index) => (mask & (1 << index)) !== 0);
    const accepted = states.filter((state) => chosen.every(([, predicate]) => predicate(state)));
    if (accepted.length === target.size && accepted.every((state) => target.has(stateKey(state)))) {
      candidates.push({
        names: chosen.map(([name]) => name),
        states: accepted,
      });
    }
  }

  assert.ok(candidates.length > 0, 'safe set is not representable as a positive conjunction');
  candidates.sort(
    (left, right) =>
      left.names.length - right.names.length ||
      left.names.join(' && ').localeCompare(right.names.join(' && ')),
  );
  return candidates[0]!.names.join(' && ');
}

const settleWp = weakestPrecondition('SETTLE');
const releaseWp = weakestPrecondition('RELEASE');
const replayWp = weakestPrecondition('REPLAY');

const settleFormula = derivePositiveConjunction(settleWp);
const releaseFormula = derivePositiveConjunction(releaseWp);
const replayFormula = derivePositiveConjunction(replayWp);

assert.equal(
  settleFormula,
  'current_authority && exact_attempt_binding && evidence=verified-present',
);
assert.equal(
  releaseFormula,
  'current_authority && exact_attempt_binding && adapter_match && evidence=not-dispatched',
);
assert.equal(
  replayFormula,
  'current_authority && exact_attempt_binding && adapter_match && replay_protected && evidence=terminal-absence',
);

const settleKeys = new Set(settleWp.map(stateKey));
const releaseKeys = new Set(releaseWp.map(stateKey));
const replayKeys = new Set(replayWp.map(stateKey));

function chooseAction(state: State): Action {
  const key = stateKey(state);
  if (settleKeys.has(key)) return 'SETTLE';
  if (releaseKeys.has(key)) return 'RELEASE';
  if (replayKeys.has(key)) return 'REPLAY';
  return 'RECOVERY_REQUIRED';
}

const partition = states.map((state) => ({ state, action: chooseAction(state) }));
assert.equal(partition.length, 64);
assert.equal(partition.filter(({ action }) => action === 'SETTLE').length, settleWp.length);
assert.equal(partition.filter(({ action }) => action === 'RELEASE').length, releaseWp.length);
assert.equal(partition.filter(({ action }) => action === 'REPLAY').length, replayWp.length);
assert.equal(
  partition.filter(({ action }) => action === 'RECOVERY_REQUIRED').length,
  states.length - settleWp.length - releaseWp.length - replayWp.length,
);

for (const state of states) {
  const memberships = [
    settleKeys.has(stateKey(state)),
    releaseKeys.has(stateKey(state)),
    replayKeys.has(stateKey(state)),
  ].filter(Boolean).length;
  assert.ok(memberships <= 1, `safe action overlap at ${stateKey(state)}`);
}

const gapStates = partition.filter(({ action }) => action === 'RECOVERY_REQUIRED');
assert.ok(gapStates.length > 0, 'hostile ambiguous states must remain unresolved');

const adapterIndependenceState: State = {
  current_authority: true,
  exact_attempt_binding: true,
  adapter_match: false,
  replay_protected: false,
  evidence: 'verified-present',
};
assert.equal(chooseAction(adapterIndependenceState), 'SETTLE');

const verifiedAsNotDispatchedMutant = (state: State): boolean =>
  state.current_authority &&
  state.exact_attempt_binding &&
  state.adapter_match &&
  ['not-dispatched', 'verified-present'].includes(state.evidence);
const mutantUnsafeRelease = states.filter(
  (state) => verifiedAsNotDispatchedMutant(state) && !releaseKeys.has(stateKey(state)),
);
assert.ok(mutantUnsafeRelease.length > 0);

const absenceAsNotDispatchedMutant = (state: State): boolean =>
  state.current_authority &&
  state.exact_attempt_binding &&
  state.adapter_match &&
  ['not-dispatched', 'terminal-absence'].includes(state.evidence);
const mutantAbsenceUnsafeRelease = states.filter(
  (state) => absenceAsNotDispatchedMutant(state) && !releaseKeys.has(stateKey(state)),
);
assert.ok(mutantAbsenceUnsafeRelease.length > 0);

const noRecoveryFallback = partition.filter(({ action }) => action !== 'RECOVERY_REQUIRED');
assert.ok(noRecoveryFallback.length < states.length);

const github = effectAdapterCapabilities(GITHUB_COMMIT_STATUS_EFFECT);
assert.ok(github);
assert.equal(github.duplicate_delivery, 'may-duplicate');
assert.equal(github.replay.kind, 'forbidden');

const work = {
  id: 'github-status',
  dependencies: [],
  packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
  postcondition: {
    verifier: 'github-commit-status/v2' as const,
    provider: 'github' as const,
    repository_id: 1,
    repository_full_name: 'acme/widget',
    commit_sha: 'abc123',
    context: 'ci/test',
    expected_state: 'success' as const,
  },
};

const verifiedObservation: Observation = {
  verifier: 'github-commit-status/v2',
  provider: 'github',
  repository_id: 1,
  repository_full_name: 'acme/widget',
  commit_sha: 'abc123',
  context: 'ci/test',
  expected_state: 'success',
  actual_state: 'success',
  mutation_certainty: 'present',
};

const wrongStateObservation: Observation = {
  ...verifiedObservation,
  actual_state: 'failure',
};

assert.equal(observationVerified(work.postcondition, verifiedObservation), true);
assert.equal(observationVerified(work.postcondition, wrongStateObservation), false);

const receiptFact = (observed: Observation): ReceiptFact => ({
  schema: RECEIPT_SCHEMA,
  run_id: 'run',
  obligation_id: work.id,
  claimed_revision: 'revision',
  claim_commit: 'claim',
  execution_generation: 1,
  execution_authority_commit: 'authority',
  kind: 'observation',
  observed,
  settled_at: '2026-09-24T00:00:00.000Z',
});

const settledWithReservation = projectReceipt(
  receiptFact(verifiedObservation),
  work,
  undefined,
  true,
);
assert.equal(settledWithReservation.verified, true);
assert.equal(settledWithReservation.disposition, 'DONE');

const mismatchedAdapterWork = {
  ...work,
  packet: { effect_contract: 'unregistered/mismatched-adapter' },
};
const settledDespiteAdapterMismatch = projectReceipt(
  receiptFact(verifiedObservation),
  mismatchedAdapterWork,
  undefined,
  true,
);
assert.equal(settledDespiteAdapterMismatch.verified, true);
assert.equal(settledDespiteAdapterMismatch.disposition, 'DONE');

const unresolvedWrongState = projectReceipt(
  receiptFact(wrongStateObservation),
  work,
  undefined,
  true,
);
assert.equal(unresolvedWrongState.verified, false);
assert.equal(unresolvedWrongState.disposition, 'RECOVERY_REQUIRED');

const attempt = {
  run_id: 'run',
  obligation_id: work.id,
  execution_generation: 1,
  execution_authority_commit: 'authority',
  reservation_commit: 'reservation',
  effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
};

const preSecureWitness: ValidatedEffectReleaseWitness = {
  kind: GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
  source: 'github-status/fresh-https',
  attempt,
  observation: {
    schema: GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA,
    schema_version: GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION,
    transport: 'https',
    fresh_socket: true,
    secure_connected: false,
    method: 'POST',
    origin: GITHUB_STATUS_PROVIDER_ORIGIN,
    path: '/repos/acme/widget/statuses/abc123',
    body_sha256: canonicalDigest({
      state: 'success',
      context: 'ci/test',
      description: 'Overcenter trusted effect broker',
    }),
    error_code: 'ECONNREFUSED',
  },
};

assert.equal(
  reservedEffectReleaseWitnessSafe(work, GITHUB_COMMIT_STATUS_EFFECT, preSecureWitness),
  true,
);

const githubCases = {
  verified_desired_state: chooseAction({
    current_authority: true,
    exact_attempt_binding: true,
    adapter_match: false,
    replay_protected: false,
    evidence: 'verified-present',
  }),
  trusted_pre_dispatch_failure: chooseAction({
    current_authority: true,
    exact_attempt_binding: true,
    adapter_match: true,
    replay_protected: false,
    evidence: 'not-dispatched',
  }),
  authoritative_terminal_absence: chooseAction({
    current_authority: true,
    exact_attempt_binding: true,
    adapter_match: true,
    replay_protected: false,
    evidence: 'terminal-absence',
  }),
  post_connect_or_502_ambiguity: chooseAction({
    current_authority: true,
    exact_attempt_binding: true,
    adapter_match: true,
    replay_protected: false,
    evidence: 'ambiguous',
  }),
} as const;

assert.deepEqual(githubCases, {
  verified_desired_state: 'SETTLE',
  trusted_pre_dispatch_failure: 'RELEASE',
  authoritative_terminal_absence: 'RECOVERY_REQUIRED',
  post_connect_or_502_ambiguity: 'RECOVERY_REQUIRED',
});

const replayableControl = chooseAction({
  current_authority: true,
  exact_attempt_binding: true,
  adapter_match: true,
  replay_protected: true,
  evidence: 'terminal-absence',
});
assert.equal(replayableControl, 'REPLAY');

console.log('recovery action partition experiment: SUPPORTED');
console.log(
  JSON.stringify(
    {
      state_space: states.length,
      weakest_preconditions: {
        SETTLE: settleFormula,
        RELEASE: releaseFormula,
        REPLAY: replayFormula,
      },
      safe_state_counts: {
        SETTLE: settleWp.length,
        RELEASE: releaseWp.length,
        REPLAY: replayWp.length,
        RECOVERY_REQUIRED: gapStates.length,
      },
      partition: {
        exactly_one_action_per_state: true,
        safe_action_overlap_states: 0,
        recovery_gap_states: gapStates.length,
      },
      hostile_controls: {
        verified_misclassified_as_not_dispatched: mutantUnsafeRelease.length,
        terminal_absence_misclassified_as_not_dispatched: mutantAbsenceUnsafeRelease.length,
        missing_recovery_fallback_unclassified_states: states.length - noRecoveryFallback.length,
      },
      production_differential: {
        verified_observation: observationVerified(work.postcondition, verifiedObservation),
        verified_with_unresolved_reservation: settledWithReservation.disposition,
        verified_with_adapter_mismatch: settledDespiteAdapterMismatch.disposition,
        wrong_state_with_unresolved_reservation: unresolvedWrongState.disposition,
        pre_secure_connect_release_semantic: reservedEffectReleaseWitnessSafe(
          work,
          GITHUB_COMMIT_STATUS_EFFECT,
          preSecureWitness,
        ),
        github_cases: githubCases,
        replayable_terminal_absence_control: replayableControl,
      },
    },
    null,
    2,
  ),
);
