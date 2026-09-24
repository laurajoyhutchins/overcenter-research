import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { OvercenterKernel } from '../../src/authority/kernel.ts';
import { projectReceipt } from '../../src/authority/replay.ts';

type ProviderObservation = 'verified-present' | 'terminal-absence' | 'ambiguous' | 'none';
type AffirmativeAction = 'SETTLE' | 'RELEASE' | 'REPLAY';
type Action = AffirmativeAction | 'RECOVERY_REQUIRED';

interface State {
  current_authority: boolean;
  exact_revision: boolean;
  reservation_binding: boolean;
  adapter_match: boolean;
  replay_protected: boolean;
  not_dispatched: boolean;
  provider_observation: ProviderObservation;
}

interface HiddenOutcome {
  prior_effect_occurred: boolean;
  provider_desired_present: boolean;
}

const bools = [false, true] as const;
const providerObservations = [
  'verified-present',
  'terminal-absence',
  'ambiguous',
  'none',
] as const satisfies readonly ProviderObservation[];

const states: State[] = [];
for (const current_authority of bools) {
  for (const exact_revision of bools) {
    for (const reservation_binding of bools) {
      for (const adapter_match of bools) {
        for (const replay_protected of bools) {
          for (const not_dispatched of bools) {
            for (const provider_observation of providerObservations) {
              states.push({
                current_authority,
                exact_revision,
                reservation_binding,
                adapter_match,
                replay_protected,
                not_dispatched,
                provider_observation,
              });
            }
          }
        }
      }
    }
  }
}

const stateKey = (state: State): string =>
  [
    state.current_authority ? 'A1' : 'A0',
    state.exact_revision ? 'R1' : 'R0',
    state.reservation_binding ? 'B1' : 'B0',
    state.adapter_match ? 'M1' : 'M0',
    state.replay_protected ? 'P1' : 'P0',
    state.not_dispatched ? 'N1' : 'N0',
    state.provider_observation,
  ].join(':');

function hiddenOutcomes(state: State): HiddenOutcome[] {
  const prior = state.not_dispatched ? ([false] as const) : ([false, true] as const);
  const present =
    state.provider_observation === 'verified-present'
      ? ([true] as const)
      : state.provider_observation === 'terminal-absence'
        ? ([false] as const)
        : ([false, true] as const);

  return prior.flatMap((prior_effect_occurred) =>
    present.map((provider_desired_present) => ({
      prior_effect_occurred,
      provider_desired_present,
    })),
  );
}

function safe(action: AffirmativeAction, state: State, outcome: HiddenOutcome): boolean {
  if (!state.current_authority || !state.exact_revision) return false;

  if (action === 'SETTLE') {
    return outcome.provider_desired_present;
  }

  if (!state.adapter_match) return false;

  if (action === 'RELEASE') {
    return state.reservation_binding && !outcome.prior_effect_occurred;
  }

  return state.replay_protected && !outcome.provider_desired_present;
}

function weakestPrecondition(action: AffirmativeAction): State[] {
  return states.filter((state) =>
    hiddenOutcomes(state).every((outcome) => safe(action, state, outcome)),
  );
}

const atomicPredicates = [
  ['current_authority', (state: State) => state.current_authority],
  ['exact_revision', (state: State) => state.exact_revision],
  ['reservation_binding', (state: State) => state.reservation_binding],
  ['adapter_match', (state: State) => state.adapter_match],
  ['replay_protected', (state: State) => state.replay_protected],
  ['not_dispatched', (state: State) => state.not_dispatched],
  [
    'provider_observation=verified-present',
    (state: State) => state.provider_observation === 'verified-present',
  ],
  [
    'provider_observation=terminal-absence',
    (state: State) => state.provider_observation === 'terminal-absence',
  ],
] as const;

function derivePositiveConjunction(selected: readonly State[]): string {
  const target = new Set(selected.map(stateKey));
  const candidates: string[][] = [];
  const count = atomicPredicates.length;

  for (let mask = 0; mask < 1 << count; mask += 1) {
    const chosen = atomicPredicates.filter((_, index) => (mask & (1 << index)) !== 0);
    const accepted = states.filter((state) => chosen.every(([, predicate]) => predicate(state)));
    if (accepted.length === target.size && accepted.every((state) => target.has(stateKey(state)))) {
      candidates.push(chosen.map(([name]) => name));
    }
  }

  assert.ok(candidates.length > 0, 'safe set is not representable as a positive conjunction');
  candidates.sort(
    (left, right) =>
      left.length - right.length || left.join(' && ').localeCompare(right.join(' && ')),
  );
  return candidates[0]!.join(' && ');
}

const settleWp = weakestPrecondition('SETTLE');
const releaseWp = weakestPrecondition('RELEASE');
const replayWp = weakestPrecondition('REPLAY');

const settleFormula = derivePositiveConjunction(settleWp);
const releaseFormula = derivePositiveConjunction(releaseWp);
const replayFormula = derivePositiveConjunction(replayWp);

assert.equal(
  settleFormula,
  'current_authority && exact_revision && provider_observation=verified-present',
);
assert.equal(
  releaseFormula,
  'current_authority && exact_revision && reservation_binding && adapter_match && not_dispatched',
);
assert.equal(
  replayFormula,
  'current_authority && exact_revision && adapter_match && replay_protected && provider_observation=terminal-absence',
);

assert.equal(settleWp.length, 16);
assert.equal(releaseWp.length, 8);
assert.equal(replayWp.length, 4);

const safeKeys = {
  SETTLE: new Set(settleWp.map(stateKey)),
  RELEASE: new Set(releaseWp.map(stateKey)),
  REPLAY: new Set(replayWp.map(stateKey)),
} as const;

function safeActions(state: State): Set<AffirmativeAction> {
  const key = stateKey(state);
  return new Set(
    (['SETTLE', 'RELEASE', 'REPLAY'] as const).filter((action) => safeKeys[action].has(key)),
  );
}

const actionPrecedence = ['SETTLE', 'RELEASE', 'REPLAY'] as const;

function chooseAction(state: State): Action {
  const admitted = safeActions(state);
  return actionPrecedence.find((action) => admitted.has(action)) ?? 'RECOVERY_REQUIRED';
}

const partition = states.map((state) => ({
  state,
  admitted: safeActions(state),
  action: chooseAction(state),
}));

for (const { state, admitted, action } of partition) {
  if (action === 'RECOVERY_REQUIRED') {
    assert.equal(admitted.size, 0, `recovery chosen despite safe action at ${stateKey(state)}`);
    continue;
  }
  assert.ok(admitted.has(action), `unsafe affirmative action chosen at ${stateKey(state)}`);
  assert.equal(
    action,
    actionPrecedence.find((candidate) => admitted.has(candidate)),
    `precedence mismatch at ${stateKey(state)}`,
  );
}

const settleReleaseOverlap = partition.filter(
  ({ admitted }) => admitted.has('SETTLE') && admitted.has('RELEASE'),
);
const releaseReplayOverlap = partition.filter(
  ({ admitted }) => admitted.has('RELEASE') && admitted.has('REPLAY'),
);
const settleReplayOverlap = partition.filter(
  ({ admitted }) => admitted.has('SETTLE') && admitted.has('REPLAY'),
);

assert.equal(settleReleaseOverlap.length, 2);
assert.equal(releaseReplayOverlap.length, 1);
assert.equal(settleReplayOverlap.length, 0);
assert.ok(settleReleaseOverlap.every(({ action }) => action === 'SETTLE'));
assert.ok(releaseReplayOverlap.every(({ action }) => action === 'RELEASE'));

const actionCounts = Object.fromEntries(
  (['SETTLE', 'RELEASE', 'REPLAY', 'RECOVERY_REQUIRED'] as const).map((action) => [
    action,
    partition.filter((candidate) => candidate.action === action).length,
  ]),
);
assert.deepEqual(actionCounts, {
  SETTLE: 16,
  RELEASE: 6,
  REPLAY: 3,
  RECOVERY_REQUIRED: 231,
});

const releaseWithoutReservationBinding = states.filter(
  (state) =>
    state.current_authority &&
    state.exact_revision &&
    state.adapter_match &&
    state.not_dispatched &&
    !safeKeys.RELEASE.has(stateKey(state)),
);
assert.ok(releaseWithoutReservationBinding.some((state) => !state.reservation_binding));

const verifiedAsNotDispatchedMutant = states.filter(
  (state) =>
    state.current_authority &&
    state.exact_revision &&
    state.reservation_binding &&
    state.adapter_match &&
    (state.not_dispatched || state.provider_observation === 'verified-present') &&
    !safeKeys.RELEASE.has(stateKey(state)),
);
assert.ok(verifiedAsNotDispatchedMutant.length > 0);

const absenceAsNotDispatchedMutant = states.filter(
  (state) =>
    state.current_authority &&
    state.exact_revision &&
    state.reservation_binding &&
    state.adapter_match &&
    (state.not_dispatched || state.provider_observation === 'terminal-absence') &&
    !safeKeys.RELEASE.has(stateKey(state)),
);
assert.ok(absenceAsNotDispatchedMutant.length > 0);

const settleRequiresReservationBindingOverconstraint = settleWp.filter(
  (state) => !state.reservation_binding,
);
const replayRequiresReservationBindingOverconstraint = replayWp.filter(
  (state) => !state.reservation_binding,
);
assert.ok(settleRequiresReservationBindingOverconstraint.length > 0);
assert.ok(replayRequiresReservationBindingOverconstraint.length > 0);

const settleWithoutExactRevisionMutant = states.filter(
  (state) =>
    state.current_authority &&
    state.provider_observation === 'verified-present' &&
    !safeKeys.SETTLE.has(stateKey(state)),
);
assert.ok(settleWithoutExactRevisionMutant.some((state) => !state.exact_revision));

const github = effectAdapterCapabilities(GITHUB_COMMIT_STATUS_EFFECT);
assert.ok(github);
assert.equal(github.duplicate_delivery, 'may-duplicate');
assert.equal(github.replay.kind, 'forbidden');

const commitSha = 'a'.repeat(40);
const work = {
  id: 'github-status',
  dependencies: [],
  packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
  postcondition: {
    verifier: 'github-commit-status/v2' as const,
    provider: 'github' as const,
    repository_id: 1,
    repository_full_name: 'acme/widget',
    commit_sha: commitSha,
    context: 'ci/test',
    expected_state: 'success' as const,
  },
};

const verifiedObservation: Observation = {
  verifier: 'github-commit-status/v2',
  provider: 'github',
  repository_id: 1,
  repository_full_name: 'acme/widget',
  commit_sha: commitSha,
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
    path: `/repos/acme/widget/statuses/${commitSha}`,
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
  verified_and_not_dispatched: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: true,
    adapter_match: true,
    replay_protected: false,
    not_dispatched: true,
    provider_observation: 'verified-present',
  }),
  not_dispatched_without_provider_result: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: true,
    adapter_match: true,
    replay_protected: false,
    not_dispatched: true,
    provider_observation: 'none',
  }),
  terminal_absence_without_replay_protection: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: false,
    adapter_match: true,
    replay_protected: false,
    not_dispatched: false,
    provider_observation: 'terminal-absence',
  }),
  terminal_absence_with_replay_protection: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: false,
    adapter_match: true,
    replay_protected: true,
    not_dispatched: false,
    provider_observation: 'terminal-absence',
  }),
  not_dispatched_and_replayable_absence: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: true,
    adapter_match: true,
    replay_protected: true,
    not_dispatched: true,
    provider_observation: 'terminal-absence',
  }),
  ambiguous: chooseAction({
    current_authority: true,
    exact_revision: true,
    reservation_binding: false,
    adapter_match: true,
    replay_protected: false,
    not_dispatched: false,
    provider_observation: 'ambiguous',
  }),
} as const;

assert.deepEqual(githubCases, {
  verified_and_not_dispatched: 'SETTLE',
  not_dispatched_without_provider_result: 'RELEASE',
  terminal_absence_without_replay_protection: 'RECOVERY_REQUIRED',
  terminal_absence_with_replay_protection: 'REPLAY',
  not_dispatched_and_replayable_absence: 'RELEASE',
  ambiguous: 'RECOVERY_REQUIRED',
});

const root = mkdtempSync(join(tmpdir(), 'recovery-action-partition-'));
const database = join(root, 'overcenter.sqlite');
const target = join(root, 'result.txt');
writeFileSync(target, 'expected');
const kernel = new OvercenterKernel(database, {
  observationContext: { localFileRoot: root },
});

let successorSettlement: {
  stale_authority_rejected: boolean;
  wrong_revision_rejected: boolean;
  successor_disposition: string;
  unresolved_effect_after_settlement: boolean;
} | null = null;

try {
  kernel.initialize();
  kernel.define({
    id: 'two-clock-settlement',
    packet: { effect_contract: 'unregistered/effect' },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: target,
      content: 'expected',
    },
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const initialPermit = kernel.claim(ready.id, ready.revision);
  kernel.beginEffect(initialPermit);
  assert.equal(kernel.hasUnresolvedEffect(initialPermit.id), true);

  const successorPermit = kernel.acquireExecution(initialPermit.id);
  assert.notEqual(successorPermit.execution_generation, initialPermit.execution_generation);
  assert.equal(kernel.hasUnresolvedEffect(initialPermit.id), true);

  assert.throws(() => kernel.resolve(initialPermit), /STALE_EXECUTION_GENERATION/);
  const wrongRevisionPermit = {
    ...successorPermit,
    claimed_revision: 'wrong-revision',
  };
  assert.throws(() => kernel.resolve(wrongRevisionPermit), /STALE_EXECUTION_GENERATION/);

  const receipt = kernel.resolve(successorPermit);
  assert.equal(receipt.disposition, 'DONE');
  assert.equal(kernel.hasUnresolvedEffect(initialPermit.id), false);

  successorSettlement = {
    stale_authority_rejected: true,
    wrong_revision_rejected: true,
    successor_disposition: receipt.disposition,
    unresolved_effect_after_settlement: kernel.hasUnresolvedEffect(initialPermit.id),
  };
} finally {
  kernel.close();
  rmSync(root, { recursive: true, force: true });
}

assert.ok(successorSettlement);

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
      },
      safe_action_overlaps: {
        settle_release: settleReleaseOverlap.length,
        release_replay: releaseReplayOverlap.length,
        settle_replay: settleReplayOverlap.length,
      },
      chosen_action_counts: actionCounts,
      precedence: actionPrecedence,
      hostile_controls: {
        release_without_reservation_binding: releaseWithoutReservationBinding.filter(
          (state) => !state.reservation_binding,
        ).length,
        verified_misclassified_as_not_dispatched: verifiedAsNotDispatchedMutant.length,
        terminal_absence_misclassified_as_not_dispatched: absenceAsNotDispatchedMutant.length,
        settle_overconstrained_by_reservation_binding:
          settleRequiresReservationBindingOverconstraint.length,
        replay_overconstrained_by_reservation_binding:
          replayRequiresReservationBindingOverconstraint.length,
        settle_without_exact_revision: settleWithoutExactRevisionMutant.filter(
          (state) => !state.exact_revision,
        ).length,
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
        successor_authority_settlement: successorSettlement,
      },
    },
    null,
    2,
  ),
);
