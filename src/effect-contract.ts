import type { AbsenceEvidenceCertificate, Obligation, Postcondition } from './model.ts';
import { canonicalDigest } from './digest.ts';
import type { ValidatedEffectReleaseWitness } from './effect-release-witness.ts';
import { isData as data } from './validation.ts';

export const EFFECT_CONTRACT_CAPABILITIES_SCHEMA =
  'overcenter-effect-contract-capabilities' as const;

export const GITHUB_COMMIT_STATUS_EFFECT =
  'github-commit-status/set-from-postcondition/v1' as const;

export const GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT =
  'github-pull-request/update-branch' as const;

export type DuplicateDeliverySemantics =
  | 'may-duplicate'
  | 'at-most-once'
  | 'semantically-idempotent';

export type ReplayCapability =
  | {
      kind: 'forbidden';
      reason: string;
    }
  | {
      kind: 'terminal-absence';
      terminal_absence_evidence_kinds: readonly string[];
    };

export type ReservationReleaseCapability =
  | { kind: 'forbidden'; reason: string }
  | { kind: 'not-dispatched'; evidence_kinds: readonly string[] };

export const GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED =
  'github-status/fresh-https-pre-secure-connect' as const;
export const GITHUB_STATUS_PROVIDER_ORIGIN = 'https://api.github.com' as const;
export const GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA =
  'overcenter-github-status-not-dispatched-observation' as const;
export const GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION = 1 as const;

export interface EffectContractCapabilities {
  schema: typeof EFFECT_CONTRACT_CAPABILITIES_SCHEMA;
  effect_contract: string;
  postcondition_verifier: Postcondition['verifier'];
  duplicate_delivery: DuplicateDeliverySemantics;
  replay: ReplayCapability;
  reservation_release: ReservationReleaseCapability;
}

export function validateEffectContractCapabilities(capabilities: EffectContractCapabilities): void {
  if (capabilities.schema !== EFFECT_CONTRACT_CAPABILITIES_SCHEMA) {
    throw new Error('EFFECT_CONTRACT_CAPABILITIES_SCHEMA_INVALID');
  }
  if (!capabilities.effect_contract) {
    throw new Error('EFFECT_CONTRACT_INVALID');
  }
  if (capabilities.replay.kind === 'forbidden') {
    if (!capabilities.replay.reason) throw new Error('FORBIDDEN_REPLAY_REQUIRES_REASON');
  } else {
    if (capabilities.replay.terminal_absence_evidence_kinds.length === 0) {
      throw new Error('REPLAY_CAPABILITY_REQUIRES_TERMINAL_EVIDENCE');
    }
    if (capabilities.duplicate_delivery === 'may-duplicate') {
      throw new Error('REPLAY_CAPABILITY_REQUIRES_DUPLICATE_EFFECT_PROTECTION');
    }
  }
  if (capabilities.reservation_release.kind === 'forbidden') {
    if (!capabilities.reservation_release.reason) {
      throw new Error('FORBIDDEN_RESERVATION_RELEASE_REQUIRES_REASON');
    }
  } else if (capabilities.reservation_release.evidence_kinds.length === 0) {
    throw new Error('RESERVATION_RELEASE_REQUIRES_EVIDENCE_KIND');
  }
}

export const EFFECT_CONTRACT_CAPABILITIES = [
  {
    schema: EFFECT_CONTRACT_CAPABILITIES_SCHEMA,
    effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
    postcondition_verifier: 'github-commit-status/v2',
    duplicate_delivery: 'may-duplicate',
    replay: {
      kind: 'forbidden',
      reason: 'provider request finality and duplicate-effect suppression are not established',
    },
    reservation_release: {
      kind: 'not-dispatched',
      evidence_kinds: [GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED],
    },
  },
  {
    schema: EFFECT_CONTRACT_CAPABILITIES_SCHEMA,
    effect_contract: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    postcondition_verifier: 'github-pull-request-branch-updated/v1',
    duplicate_delivery: 'may-duplicate',
    replay: {
      kind: 'forbidden',
      reason: 'provider request finality and duplicate-effect suppression are not established',
    },
    reservation_release: {
      kind: 'forbidden',
      reason: 'no trusted pre-dispatch evidence boundary is admitted for this effect contract',
    },
  },
] as const satisfies readonly EffectContractCapabilities[];

export type RegisteredEffectContractDefinition = (typeof EFFECT_CONTRACT_CAPABILITIES)[number];
export type RegisteredEffectContract = RegisteredEffectContractDefinition['effect_contract'];
export type EffectVerifier<E extends RegisteredEffectContract> = Extract<
  RegisteredEffectContractDefinition,
  { effect_contract: E }
>['postcondition_verifier'];

for (const capabilities of EFFECT_CONTRACT_CAPABILITIES) {
  validateEffectContractCapabilities(capabilities);
}

export function effectContractCapabilities(
  effectContract: unknown,
): EffectContractCapabilities | null {
  return (
    EFFECT_CONTRACT_CAPABILITIES.find(
      (capabilities) => capabilities.effect_contract === effectContract,
    ) ?? null
  );
}

export function reservedEffectReplaySafe(
  work: Obligation,
  absenceEvidence: AbsenceEvidenceCertificate,
): boolean {
  const capabilities = effectContractCapabilities(work.packet.effect_contract);
  if (!capabilities) return false;
  if (capabilities.postcondition_verifier !== work.postcondition.verifier) {
    return false;
  }
  if (capabilities.replay.kind !== 'terminal-absence') return false;
  return capabilities.replay.terminal_absence_evidence_kinds.includes(absenceEvidence.kind);
}

export function reservedEffectReleaseSafe(
  work: Obligation,
  effectContract: string,
  evidenceKind: string,
): boolean {
  const capabilities = effectContractCapabilities(work.packet.effect_contract);
  if (!capabilities) return false;
  if (capabilities.effect_contract !== effectContract) return false;
  if (capabilities.postcondition_verifier !== work.postcondition.verifier) return false;
  return (
    capabilities.reservation_release.kind === 'not-dispatched' &&
    capabilities.reservation_release.evidence_kinds.includes(evidenceKind)
  );
}

export function reservedEffectReleaseWitnessSafe(
  work: Obligation,
  effectContract: string,
  witness: ValidatedEffectReleaseWitness,
): boolean {
  if (!reservedEffectReleaseSafe(work, effectContract, witness.kind)) return false;
  if (witness.kind !== GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED) return false;
  if (work.postcondition.verifier !== 'github-commit-status/v2') return false;
  if (!data(witness.observation)) return false;

  const [owner, repo, ...extra] = work.postcondition.repository_full_name.split('/');
  if (!owner || !repo || extra.length > 0) return false;
  const expectedPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(
    work.postcondition.commit_sha,
  )}`;
  const expectedBodyDigest = canonicalDigest({
    state: work.postcondition.expected_state,
    context: work.postcondition.context,
    description: 'Overcenter trusted effect broker',
  });

  return (
    witness.observation.schema === GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA &&
    witness.observation.schema_version ===
      GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION &&
    witness.observation.transport === 'https' &&
    witness.observation.fresh_socket === true &&
    witness.observation.secure_connected === false &&
    witness.observation.method === 'POST' &&
    witness.observation.origin === GITHUB_STATUS_PROVIDER_ORIGIN &&
    witness.observation.path === expectedPath &&
    witness.observation.body_sha256 === expectedBodyDigest
  );
}
