import assert from 'node:assert/strict';

import { canonicalDigest } from '../../src/digest.ts';
import {
  EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION,
  GITHUB_STATUS_PROVIDER_ORIGIN,
  effectAdapterCapabilities,
  reservedEffectReleaseWitnessSafe,
  reservedEffectReplaySafe,
  validateEffectAdapterCapabilities,
  type EffectAdapterCapabilities,
} from '../../src/effect-adapter.ts';
import type { ValidatedEffectReleaseWitness } from '../../src/effect-release-witness.ts';
import type { AbsenceEvidenceCertificate, Obligation } from '../../src/model.ts';

interface State {
  current_authority: boolean;
  exact_attempt_binding: boolean;
  adapter_match: boolean;
  not_dispatched_certificate: boolean;
  terminal_absence_certificate: boolean;
  replay_protected: boolean;
}

interface ReleaseOutcome {
  prior_effect_occurred: boolean;
}

interface ReplayOutcome {
  prior_effect_occurred: boolean;
  provider_state_conflict: boolean;
}

type StateKey = keyof State;
type Choice = -1 | 0 | 1;

const variables = [
  'current_authority',
  'exact_attempt_binding',
  'adapter_match',
  'not_dispatched_certificate',
  'terminal_absence_certificate',
  'replay_protected',
] as const satisfies readonly StateKey[];

const bools = [false, true] as const;
const states: State[] = [];
for (const current_authority of bools) {
  for (const exact_attempt_binding of bools) {
    for (const adapter_match of bools) {
      for (const not_dispatched_certificate of bools) {
        for (const terminal_absence_certificate of bools) {
          for (const replay_protected of bools) {
            states.push({
              current_authority,
              exact_attempt_binding,
              adapter_match,
              not_dispatched_certificate,
              terminal_absence_certificate,
              replay_protected,
            });
          }
        }
      }
    }
  }
}

const key = (state: State): string =>
  variables.map((name) => `${name}=${state[name] ? 1 : 0}`).join(',');

function releaseOutcomes(state: State): readonly ReleaseOutcome[] {
  return (state.not_dispatched_certificate ? [false] : [false, true]).map(
    (prior_effect_occurred) => ({ prior_effect_occurred }),
  );
}

function replayOutcomes(state: State): readonly ReplayOutcome[] {
  const prior = [false, true] as const;
  const conflicts = state.terminal_absence_certificate ? ([false] as const) : ([false, true] as const);
  return prior.flatMap((prior_effect_occurred) =>
    conflicts.map((provider_state_conflict) => ({
      prior_effect_occurred,
      provider_state_conflict,
    })),
  );
}

function releaseSafe(state: State, outcome: ReleaseOutcome): boolean {
  return (
    state.current_authority &&
    state.exact_attempt_binding &&
    state.adapter_match &&
    !outcome.prior_effect_occurred
  );
}

function replaySafe(state: State, outcome: ReplayOutcome): boolean {
  return (
    state.current_authority &&
    state.exact_attempt_binding &&
    state.adapter_match &&
    !outcome.provider_state_conflict &&
    (state.replay_protected || !outcome.prior_effect_occurred)
  );
}

function weakestPrecondition<T>(
  outcomes: (state: State) => readonly T[],
  postcondition: (state: State, outcome: T) => boolean,
): State[] {
  return states.filter((state) => outcomes(state).every((outcome) => postcondition(state, outcome)));
}

function deriveConjunction(selected: readonly State[]): string {
  const target = new Set(selected.map(key));
  if (target.size === 0) return 'false';

  const choices: readonly Choice[] = [-1, 0, 1];
  const matches: string[][] = [];
  const visit = (index: number, vector: Choice[]): void => {
    if (index === variables.length) {
      const accepted = states.filter((state) =>
        variables.every((variable, i) => {
          const choice = vector[i]!;
          return choice === 0 || state[variable] === (choice === 1);
        }),
      );
      if (
        accepted.length === target.size &&
        accepted.every((state) => target.has(key(state)))
      ) {
        matches.push(
          variables.flatMap((variable, i) => {
            const choice = vector[i]!;
            if (choice === 0) return [];
            return [choice === 1 ? variable : `!${variable}`];
          }),
        );
      }
      return;
    }
    for (const choice of choices) visit(index + 1, [...vector, choice]);
  };
  visit(0, []);

  assert.ok(matches.length > 0, 'safe state set is not representable as a conjunction of literals');
  matches.sort(
    (left, right) =>
      left.length - right.length || left.join(' && ').localeCompare(right.join(' && ')),
  );
  return matches[0]!.join(' && ');
}

const releaseWp = weakestPrecondition(releaseOutcomes, releaseSafe);
const replayWp = weakestPrecondition(replayOutcomes, replaySafe);
const releaseFormula = deriveConjunction(releaseWp);
const replayFormula = deriveConjunction(replayWp);

assert.equal(
  releaseFormula,
  'current_authority && exact_attempt_binding && adapter_match && not_dispatched_certificate',
);
assert.equal(
  replayFormula,
  'current_authority && exact_attempt_binding && adapter_match && terminal_absence_certificate && replay_protected',
);

function omittedGuardWitness(
  safe: readonly State[],
  guard: (state: State) => boolean,
): string[] {
  const safeKeys = new Set(safe.map(key));
  return states.filter((state) => guard(state) && !safeKeys.has(key(state))).map(key);
}

const releaseMutants = {
  missing_current_authority: (s: State) =>
    s.exact_attempt_binding && s.adapter_match && s.not_dispatched_certificate,
  missing_exact_attempt_binding: (s: State) =>
    s.current_authority && s.adapter_match && s.not_dispatched_certificate,
  missing_adapter_match: (s: State) =>
    s.current_authority && s.exact_attempt_binding && s.not_dispatched_certificate,
  ambiguous_release: (s: State) =>
    s.current_authority && s.exact_attempt_binding && s.adapter_match,
};
const releaseMutantWitnesses: Record<string, string[]> = {};
for (const [name, guard] of Object.entries(releaseMutants)) {
  const witnesses = omittedGuardWitness(releaseWp, guard);
  assert.ok(witnesses.length > 0, `${name} did not admit an unsafe release state`);
  releaseMutantWitnesses[name] = witnesses;
}

const replayMutants = {
  missing_current_authority: (s: State) =>
    s.exact_attempt_binding &&
    s.adapter_match &&
    s.terminal_absence_certificate &&
    s.replay_protected,
  missing_exact_attempt_binding: (s: State) =>
    s.current_authority &&
    s.adapter_match &&
    s.terminal_absence_certificate &&
    s.replay_protected,
  missing_adapter_match: (s: State) =>
    s.current_authority &&
    s.exact_attempt_binding &&
    s.terminal_absence_certificate &&
    s.replay_protected,
  missing_terminal_absence: (s: State) =>
    s.current_authority && s.exact_attempt_binding && s.adapter_match && s.replay_protected,
  missing_replay_protection: (s: State) =>
    s.current_authority &&
    s.exact_attempt_binding &&
    s.adapter_match &&
    s.terminal_absence_certificate,
};
const replayMutantWitnesses: Record<string, string[]> = {};
for (const [name, guard] of Object.entries(replayMutants)) {
  const witnesses = omittedGuardWitness(replayWp, guard);
  assert.ok(witnesses.length > 0, `${name} did not admit an unsafe replay state`);
  replayMutantWitnesses[name] = witnesses;
}

const github = effectAdapterCapabilities(GITHUB_COMMIT_STATUS_EFFECT);
assert.ok(github);
assert.equal(github.duplicate_delivery, 'may-duplicate');
assert.equal(github.replay.kind, 'forbidden');
assert.equal(github.reservation_release.kind, 'not-dispatched');

const githubReplayProtected =
  github.replay.kind === 'terminal-absence' && github.duplicate_delivery !== 'may-duplicate';
assert.equal(githubReplayProtected, false);

const work: Obligation = {
  id: 'github-status',
  dependencies: [],
  packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
  postcondition: {
    verifier: 'github-commit-status/v2',
    provider: 'github',
    repository_id: 1,
    repository_full_name: 'acme/widget',
    commit_sha: 'abc123',
    context: 'ci/test',
    expected_state: 'success',
  },
};

const attempt = {
  run_id: 'run',
  obligation_id: work.id,
  execution_generation: 1,
  execution_authority_commit: 'authority',
  reservation_commit: 'reservation',
  effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
};

const expectedPath = '/repos/acme/widget/statuses/abc123';
const expectedBodyDigest = canonicalDigest({
  state: 'success',
  context: 'ci/test',
  description: 'Overcenter trusted effect broker',
});

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
    path: expectedPath,
    body_sha256: expectedBodyDigest,
    error_code: 'ECONNREFUSED',
  },
};

const postSecureWitness: ValidatedEffectReleaseWitness = {
  ...preSecureWitness,
  observation: {
    ...preSecureWitness.observation,
    secure_connected: true,
  },
};

const wrongOriginWitness: ValidatedEffectReleaseWitness = {
  ...preSecureWitness,
  observation: {
    ...preSecureWitness.observation,
    origin: 'https://example.invalid',
  },
};

const wrongPathWitness: ValidatedEffectReleaseWitness = {
  ...preSecureWitness,
  observation: {
    ...preSecureWitness.observation,
    path: '/repos/acme/widget/statuses/other',
  },
};

const wrongBodyWitness: ValidatedEffectReleaseWitness = {
  ...preSecureWitness,
  observation: {
    ...preSecureWitness.observation,
    body_sha256: '0'.repeat(64),
  },
};

const releaseEvidenceCases = {
  pre_secure_connect: {
    not_dispatched_certificate: true,
    production_semantic_accepts: reservedEffectReleaseWitnessSafe(
      work,
      GITHUB_COMMIT_STATUS_EFFECT,
      preSecureWitness,
    ),
  },
  post_secure_connect_reset: {
    not_dispatched_certificate: false,
    production_semantic_accepts: reservedEffectReleaseWitnessSafe(
      work,
      GITHUB_COMMIT_STATUS_EFFECT,
      postSecureWitness,
    ),
  },
  http_502: {
    not_dispatched_certificate: false,
    production_semantic_accepts: false,
  },
  wrong_origin: {
    not_dispatched_certificate: false,
    production_semantic_accepts: reservedEffectReleaseWitnessSafe(
      work,
      GITHUB_COMMIT_STATUS_EFFECT,
      wrongOriginWitness,
    ),
  },
  wrong_path: {
    not_dispatched_certificate: false,
    production_semantic_accepts: reservedEffectReleaseWitnessSafe(
      work,
      GITHUB_COMMIT_STATUS_EFFECT,
      wrongPathWitness,
    ),
  },
  wrong_body: {
    not_dispatched_certificate: false,
    production_semantic_accepts: reservedEffectReleaseWitnessSafe(
      work,
      GITHUB_COMMIT_STATUS_EFFECT,
      wrongBodyWitness,
    ),
  },
} as const;

for (const [name, evidence] of Object.entries(releaseEvidenceCases)) {
  const derived = releaseSafe(
    {
      current_authority: true,
      exact_attempt_binding: true,
      adapter_match: true,
      not_dispatched_certificate: evidence.not_dispatched_certificate,
      terminal_absence_certificate: false,
      replay_protected: githubReplayProtected,
    },
    { prior_effect_occurred: false },
  );
  const fullyDerived =
    evidence.not_dispatched_certificate &&
    releaseWp.some(
      (state) =>
        state.current_authority &&
        state.exact_attempt_binding &&
        state.adapter_match &&
        state.not_dispatched_certificate &&
        !state.terminal_absence_certificate &&
        state.replay_protected === githubReplayProtected,
    );
  assert.equal(
    evidence.production_semantic_accepts,
    name === 'pre_secure_connect',
    `${name} production semantic release classification changed`,
  );
  assert.equal(
    fullyDerived,
    name === 'pre_secure_connect',
    `${name} derived release classification changed`,
  );
  assert.equal(derived, true);
}

const absence: AbsenceEvidenceCertificate = {
  schema: 'overcenter-absence-evidence-v1',
  kind: 'github-status/authoritative-terminal-absence',
  subject: {},
  scope: {},
  snapshot: null,
  completeness: {},
  provenance: {},
};
assert.equal(reservedEffectReplaySafe(work, absence), false);

const githubReplayState: State = {
  current_authority: true,
  exact_attempt_binding: true,
  adapter_match: true,
  not_dispatched_certificate: false,
  terminal_absence_certificate: true,
  replay_protected: githubReplayProtected,
};
assert.equal(replayWp.some((state) => key(state) === key(githubReplayState)), false);

const syntheticReplayable: EffectAdapterCapabilities = {
  schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
  effect_contract: 'synthetic/ensure',
  postcondition_verifier: 'file-content-equals/v1',
  duplicate_delivery: 'semantically-idempotent',
  replay: {
    kind: 'terminal-absence',
    terminal_absence_evidence_kinds: ['synthetic/terminal-absence'],
  },
  reservation_release: {
    kind: 'forbidden',
    reason: 'not part of the replay control',
  },
};
validateEffectAdapterCapabilities(syntheticReplayable);
const syntheticReplayProtected =
  syntheticReplayable.replay.kind === 'terminal-absence' &&
  syntheticReplayable.duplicate_delivery !== 'may-duplicate';
assert.equal(syntheticReplayProtected, true);

const syntheticWithAbsence: State = {
  current_authority: true,
  exact_attempt_binding: true,
  adapter_match: true,
  not_dispatched_certificate: false,
  terminal_absence_certificate: true,
  replay_protected: syntheticReplayProtected,
};
const syntheticWithoutAbsence: State = {
  ...syntheticWithAbsence,
  terminal_absence_certificate: false,
};
assert.equal(replayWp.some((state) => key(state) === key(syntheticWithAbsence)), true);
assert.equal(replayWp.some((state) => key(state) === key(syntheticWithoutAbsence)), false);

assert.throws(
  () =>
    validateEffectAdapterCapabilities({
      ...syntheticReplayable,
      duplicate_delivery: 'may-duplicate',
    }),
  /REPLAY_CAPABILITY_REQUIRES_DUPLICATE_EFFECT_PROTECTION/,
);

console.log('adapter recovery weakest-preconditions experiment: SUPPORTED');
console.log(
  JSON.stringify(
    {
      state_space: states.length,
      release: {
        weakest_precondition: releaseFormula,
        safe_states: releaseWp.length,
        missing_guard_controls: releaseMutantWitnesses,
        github_evidence: releaseEvidenceCases,
      },
      replay: {
        weakest_precondition: replayFormula,
        safe_states: replayWp.length,
        missing_guard_controls: replayMutantWitnesses,
        github: {
          duplicate_delivery: github.duplicate_delivery,
          replay_capability: github.replay.kind,
          replay_protected: githubReplayProtected,
          authoritative_terminal_absence_replay_safe: false,
        },
        synthetic_replayable_control: {
          duplicate_delivery: syntheticReplayable.duplicate_delivery,
          replay_capability: syntheticReplayable.replay.kind,
          replay_protected: syntheticReplayProtected,
          terminal_absence_required: true,
        },
      },
    },
    null,
    2,
  ),
);
