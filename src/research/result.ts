import { canonicalDigest } from '../digest.ts';
import { validateEvidenceRef, type EvidenceRef } from '../evidence/reference.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const RESEARCH_RESULT_SCHEMA = 'overcenter-research-result' as const;
export const RESEARCH_RESULT_SCHEMA_VERSION = 1 as const;

export type ResearchOutcome = 'supported' | 'falsified' | 'mixed' | 'inconclusive';

export interface ResearchResult {
  schema: typeof RESEARCH_RESULT_SCHEMA;
  schema_version: typeof RESEARCH_RESULT_SCHEMA_VERSION;
  experiment: string;
  design_digest: string;
  evaluated_revision: string;
  outcome: ResearchOutcome;
  claim: string;
  claim_digest: string;
  evidence: EvidenceRef;
}

export type ResearchResultVerifier = (result: ResearchResult) => void;

const trustedResults = new WeakSet<object>();

export type TrustedResearchResult = {
  readonly result: Readonly<Omit<ResearchResult, 'evidence'>> & {
    readonly evidence: Readonly<EvidenceRef>;
  };
};

function sha256Hex(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(error);
}

function gitSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

export function researchClaimDigest(claim: string): string {
  return canonicalDigest({
    domain: 'overcenter-research-claim',
    claim,
  });
}

export function validateResearchResult(value: unknown): ResearchResult {
  if (!isData(value)) throw new Error('RESEARCH_RESULT_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'schema_version',
      'experiment',
      'design_digest',
      'evaluated_revision',
      'outcome',
      'claim',
      'claim_digest',
      'evidence',
    ],
    [],
    'RESEARCH_RESULT_INVALID',
  );
  if (value.schema !== RESEARCH_RESULT_SCHEMA) throw new Error('RESEARCH_RESULT_SCHEMA_MISMATCH');
  if (value.schema_version !== RESEARCH_RESULT_SCHEMA_VERSION) {
    throw new Error('RESEARCH_RESULT_SCHEMA_VERSION_UNSUPPORTED');
  }
  assertNonEmptyString(value.experiment, 'RESEARCH_RESULT_EXPERIMENT_INVALID');
  sha256Hex(value.design_digest, 'RESEARCH_RESULT_DESIGN_DIGEST_INVALID');
  gitSha(value.evaluated_revision, 'RESEARCH_RESULT_EVALUATED_REVISION_INVALID');
  if (!['supported', 'falsified', 'mixed', 'inconclusive'].includes(String(value.outcome))) {
    throw new Error('RESEARCH_RESULT_OUTCOME_INVALID');
  }
  assertNonEmptyString(value.claim, 'RESEARCH_RESULT_CLAIM_INVALID');
  sha256Hex(value.claim_digest, 'RESEARCH_RESULT_CLAIM_DIGEST_INVALID');
  if (value.claim_digest !== researchClaimDigest(value.claim)) {
    throw new Error('RESEARCH_RESULT_CLAIM_DIGEST_MISMATCH');
  }
  const evidence = validateEvidenceRef(value.evidence);
  return {
    schema: RESEARCH_RESULT_SCHEMA,
    schema_version: RESEARCH_RESULT_SCHEMA_VERSION,
    experiment: value.experiment,
    design_digest: value.design_digest,
    evaluated_revision: value.evaluated_revision,
    outcome: value.outcome as ResearchOutcome,
    claim: value.claim,
    claim_digest: value.claim_digest,
    evidence,
  };
}

export function trustResearchResult(
  value: unknown,
  verifyEvidence: ResearchResultVerifier,
): TrustedResearchResult {
  const result = validateResearchResult(value);
  verifyEvidence(structuredClone(result));
  const immutable = structuredClone(result);
  Object.freeze(immutable.evidence);
  Object.freeze(immutable);
  const trusted = Object.freeze({ result: immutable });
  trustedResults.add(trusted);
  return trusted;
}

export function assertTrustedResearchResult(value: TrustedResearchResult): void {
  if (!trustedResults.has(value as object)) throw new Error('RESEARCH_RESULT_UNTRUSTED');
}

export function researchResultIdentity(value: TrustedResearchResult): string {
  assertTrustedResearchResult(value);
  const { result } = value;
  return canonicalDigest({
    domain: 'overcenter-research-result-identity',
    experiment: result.experiment,
    design_digest: result.design_digest,
    outcome: result.outcome,
    claim_digest: result.claim_digest,
  });
}
