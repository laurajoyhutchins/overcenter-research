import type { AbsenceEvidenceCertificate, Obligation, Postcondition } from './model.ts';
import { canonicalDigest } from './digest.ts';
import type { ValidatedEffectReleaseWitness } from './effect-release-witness.ts';
import { isData as data } from './validation.ts';

export const EFFECT_ADAPTER_CAPABILITIES_SCHEMA = 'overcenter-effect-adapter-capabilities' as const;

export const GITHUB_COMMIT_STATUS_EFFECT =
  'github-commit-status/set-from-postcondition/v1' as const;

export const GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT =
  'github-pull-request/update-branch' as const;

export const GITHUB_SOURCE_INTEGRATION_EFFECT =
  'github-source/integrate-verified-tree/v1' as const;

export const KUBERNETES_CONFIGMAP_EFFECT = 'kubernetes-configmap/ensure' as const;

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

export interface EffectAdapterCapabilities {
  schema: typeof EFFECT_ADAPTER_CAPABILITIES_SCHEMA;
  effect_contract: string;
  postcondition_verifier: Postcondition['verifier'];
  duplicate_delivery: DuplicateDeliverySemantics;
  replay: ReplayCapability;
  reservation_release: ReservationReleaseCapability;
}

export function validateEffectAdapterCapabilities(capabilities: EffectAdapterCapabilities): void {
  if (capabilities.schema !== EFFECT_ADAPTER_CAPABILITIES_SCHEMA) {
    throw new Error('EFFECT_ADAPTER_CAPABILITIES_SCHEMA_INVALID');
  }
  if (!capabilities.effect_contract) {
    throw new Error('EFFECT_ADAPTER_CONTRACT_INVALID');
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

export const EFFECT_ADAPTER_CAPABILITIES = [
  {
    schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
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
    schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract: KUBERNETES_CONFIGMAP_EFFECT,
    postcondition_verifier: 'kubernetes-configmap-exists/v1',
    duplicate_delivery: 'may-duplicate',
    replay: {
      kind: 'forbidden',
      reason:
        'ambiguous Kubernetes mutation outcomes must reconcile from authoritative LIST/WATCH evidence before any new mutation',
    },
    reservation_release: {
      kind: 'forbidden',
      reason: 'no trusted Kubernetes pre-dispatch evidence boundary is admitted',
    },
  },
  {
    schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    postcondition_verifier: 'github-pull-request-branch-updated/v1',
    duplicate_delivery: 'may-duplicate',
    replay: {
      kind: 'forbidden',
      reason: 'provider request finality and duplicate-effect suppression are not established',
    },
    reservation_release: {
      kind: 'forbidden',
      reason: 'no trusted pre-dispatch evidence boundary is admitted for this adapter',
    },
  },
  {
    schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    postcondition_verifier: 'source-integration/v1',
    duplicate_delivery: 'may-duplicate',
    replay: {
      kind: 'forbidden',
      reason:
        'an ambiguous source-ref mutation must be reconciled from authoritative ref readback before any retry',
    },
    reservation_release: {
      kind: 'forbidden',
      reason: 'no trusted pre-dispatch release boundary is admitted for source integration',
    },
  },
] as const satisfies readonly EffectAdapterCapabilities[];

export type RegisteredEffectAdapter = (typeof EFFECT_ADAPTER_CAPABILITIES)[number];
export type RegisteredEffectContract = RegisteredEffectAdapter['effect_contract'];
export type EffectVerifier<E extends RegisteredEffectContract> = Extract<
  RegisteredEffectAdapter,
  { effect_contract: E }
>['postcondition_verifier'];

for (const capabilities of EFFECT_ADAPTER_CAPABILITIES) {
  validateEffectAdapterCapabilities(capabilities);
}

export function effectAdapterCapabilities(
  effectContract: unknown,
): EffectAdapterCapabilities | null {
  return (
    EFFECT_ADAPTER_CAPABILITIES.find(
      (capabilities) => capabilities.effect_contract === effectContract,
    ) ?? null
  );
}

export function reservedEffectReplaySafe(
  work: Obligation,
  absenceEvidence: AbsenceEvidenceCertificate,
): boolean {
  const capabilities = effectAdapterCapabilities(work.packet.effect_contract);
  if (!capabilities) return false;
  if (capabilities.postcondition_verifier !== work.postcondition.verifier) {
    return false;
  }
  if (capabilities.replay.kind !== 'terminal-absence') return false;
  return capabilities.replay.terminal_absence_evidence_kinds.includes(absenceEvidence.kind);
}

/** Historical schema-v1 replay compatibility only; not live release authorization. */
export function legacyReleaseSafe(
  work: Obligation,
  effectContract: string,
  evidenceKind: string,
): boolean {
  const capabilities = effectAdapterCapabilities(work.packet.effect_contract);
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
  if (!legacyReleaseSafe(work, effectContract, witness.kind)) return false;
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
