import type { Data } from './model.ts';
import { canonicalJson } from './digest.ts';
import { evidenceRef, type EvidenceRef } from './evidence/reference.ts';
import {
  assertExactKeys as exactKeys,
  assertNonEmptyString as nonEmptyString,
  isData as data,
  isPositiveSafeInteger,
} from './validation.ts';
import { consumeGithubStatusNotDispatchedWitness } from './providers/github/status-transport.ts';

export const EFFECT_RELEASE_EVIDENCE_SCHEMA = 'overcenter-effect-release-evidence' as const;
export const EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION = 1 as const;

declare const trustedEffectReleaseWitnessBrand: unique symbol;
export type TrustedEffectReleaseWitness = {
  readonly [trustedEffectReleaseWitnessBrand]: true;
};

export interface EffectAttemptBinding {
  run_id: string;
  obligation_id: string;
  execution_generation: number;
  execution_authority_commit: string;
  reservation_commit: string;
  effect_contract: string;
}

export interface ValidatedEffectReleaseWitness {
  kind: string;
  source: string;
  attempt: EffectAttemptBinding;
  observation: Data;
}

export interface EffectReleaseEvidence {
  schema: typeof EFFECT_RELEASE_EVIDENCE_SCHEMA;
  schema_version: typeof EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION;
  kind: string;
  source: string;
  attempt: EffectAttemptBinding;
  observation: Data;
}

function validateAttemptBinding(value: unknown): EffectAttemptBinding {
  if (!data(value)) throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE_ATTEMPT');
  exactKeys(
    value,
    [
      'run_id',
      'obligation_id',
      'execution_generation',
      'execution_authority_commit',
      'reservation_commit',
      'effect_contract',
    ],
    [],
    'INVALID_EFFECT_RELEASE_EVIDENCE_ATTEMPT',
  );
  nonEmptyString(value.run_id, 'INVALID_EFFECT_RELEASE_EVIDENCE_RUN');
  nonEmptyString(value.obligation_id, 'INVALID_EFFECT_RELEASE_EVIDENCE_OBLIGATION');
  if (!isPositiveSafeInteger(value.execution_generation)) {
    throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE_EXECUTION_GENERATION');
  }
  nonEmptyString(
    value.execution_authority_commit,
    'INVALID_EFFECT_RELEASE_EVIDENCE_EXECUTION_AUTHORITY',
  );
  nonEmptyString(value.reservation_commit, 'INVALID_EFFECT_RELEASE_EVIDENCE_RESERVATION');
  nonEmptyString(value.effect_contract, 'INVALID_EFFECT_RELEASE_EVIDENCE_CONTRACT');
  return structuredClone(value) as unknown as EffectAttemptBinding;
}

export function validateTrustedEffectReleaseWitness(value: unknown): ValidatedEffectReleaseWitness {
  const githubStatus = consumeGithubStatusNotDispatchedWitness(value);
  if (githubStatus) return githubStatus;
  throw new Error('EFFECT_RELEASE_EVIDENCE_PROVENANCE_INVALID');
}

export function retainEffectReleaseEvidence(
  witness: ValidatedEffectReleaseWitness,
): EffectReleaseEvidence {
  return {
    schema: EFFECT_RELEASE_EVIDENCE_SCHEMA,
    schema_version: EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION,
    kind: witness.kind,
    source: witness.source,
    attempt: structuredClone(witness.attempt),
    observation: structuredClone(witness.observation),
  };
}

export function validateEffectReleaseEvidence(value: unknown): EffectReleaseEvidence {
  if (!data(value)) throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE');
  exactKeys(
    value,
    ['schema', 'schema_version', 'kind', 'source', 'attempt', 'observation'],
    [],
    'INVALID_EFFECT_RELEASE_EVIDENCE',
  );
  if (value.schema !== EFFECT_RELEASE_EVIDENCE_SCHEMA) {
    throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE_SCHEMA');
  }
  if (value.schema_version !== EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION');
  }
  nonEmptyString(value.kind, 'INVALID_EFFECT_RELEASE_EVIDENCE_KIND');
  nonEmptyString(value.source, 'INVALID_EFFECT_RELEASE_EVIDENCE_SOURCE');
  if (!data(value.observation)) throw new Error('INVALID_EFFECT_RELEASE_EVIDENCE_OBSERVATION');
  return {
    schema: EFFECT_RELEASE_EVIDENCE_SCHEMA,
    schema_version: EFFECT_RELEASE_EVIDENCE_SCHEMA_VERSION,
    kind: value.kind,
    source: value.source,
    attempt: validateAttemptBinding(value.attempt),
    observation: structuredClone(value.observation),
  };
}

export function effectReleaseEvidenceRef(evidence: EffectReleaseEvidence): EvidenceRef {
  const validated = validateEffectReleaseEvidence(evidence);
  return evidenceRef(Buffer.from(canonicalJson(validated), 'utf8'));
}
