import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export type Capability = 'github.commit-status.write' | 'github.contents.write';
export type ProviderEffectClaim = 'isolated' | 'absent' | 'ambient-write';
export type ProviderEffectGuarantee = 'controlled-isolation' | 'observed-absent' | 'present';
export type EvidenceIssuer = 'controlled-substrate-attestor' | 'trusted-capability-probe';

export const EVIDENCE_SCHEMA = 'overcenter-substrate-capability-evidence/v1' as const;

export interface SubstrateDescriptor {
  id: string;
  kind: 'controlled' | 'foreign';
  claims: {
    projectTruth: 'isolated';
    providerEffect: ProviderEffectClaim;
  };
}

export interface ObligationRequirement {
  id: string;
  capability: Capability;
  providerEffect: 'unconstrained' | 'absent-through-execution' | 'controlled-isolation';
}

export interface EvidencePayload {
  schema: typeof EVIDENCE_SCHEMA;
  issuer: EvidenceIssuer;
  substrateId: string;
  capability: Capability;
  guarantee: ProviderEffectGuarantee;
  revision: string;
  executionId: string;
  epoch: string;
}

export interface SignedEvidence extends EvidencePayload {
  signature: string;
}

export interface AdmissionContext {
  revision: string;
  executionId: string;
  epoch: string;
}

export interface TrustRoots {
  controlledSubstrateAttestor: KeyObject;
  trustedCapabilityProbe: KeyObject;
}

export interface AdmissionDecision {
  accepted: boolean;
  reasons: string[];
}

export interface FixtureFile {
  schema: string;
  fixtures: SubstrateDescriptor[];
  obligations: ObligationRequirement[];
  expected: Record<string, Record<string, boolean>>;
}

function canonicalEvidence(payload: EvidencePayload): string {
  return JSON.stringify([
    payload.schema,
    payload.issuer,
    payload.substrateId,
    payload.capability,
    payload.guarantee,
    payload.revision,
    payload.executionId,
    payload.epoch,
  ]);
}

export function issueEvidence(payload: EvidencePayload, privateKey: KeyObject): SignedEvidence {
  return {
    ...payload,
    signature: cryptoSign(null, Buffer.from(canonicalEvidence(payload)), privateKey).toString(
      'base64',
    ),
  };
}

function trustRootFor(issuer: EvidenceIssuer, trustRoots: TrustRoots): KeyObject {
  return issuer === 'controlled-substrate-attestor'
    ? trustRoots.controlledSubstrateAttestor
    : trustRoots.trustedCapabilityProbe;
}

function issuerCanAssert(issuer: EvidenceIssuer, guarantee: ProviderEffectGuarantee): boolean {
  if (guarantee === 'controlled-isolation') {
    return issuer === 'controlled-substrate-attestor';
  }
  return issuer === 'trusted-capability-probe';
}

export function verifyEvidence(
  evidence: SignedEvidence,
  descriptor: SubstrateDescriptor,
  requirement: ObligationRequirement,
  context: AdmissionContext,
  trustRoots: TrustRoots,
): AdmissionDecision {
  const reasons: string[] = [];
  const { signature, ...payload } = evidence;

  if (payload.schema !== EVIDENCE_SCHEMA) {
    reasons.push('evidence schema is not recognized');
  }

  if (
    !cryptoVerify(
      null,
      Buffer.from(canonicalEvidence(payload)),
      trustRootFor(payload.issuer, trustRoots),
      Buffer.from(signature, 'base64'),
    )
  ) {
    reasons.push('evidence signature is not trusted');
  }
  if (!issuerCanAssert(payload.issuer, payload.guarantee)) {
    reasons.push('issuer is not authoritative for this guarantee');
  }
  if (payload.substrateId !== descriptor.id) {
    reasons.push('evidence is bound to a different substrate');
  }
  if (payload.capability !== requirement.capability) {
    reasons.push('evidence is bound to a different capability');
  }
  if (payload.revision !== context.revision) {
    reasons.push('evidence is bound to a different revision');
  }
  if (payload.executionId !== context.executionId) {
    reasons.push('evidence is bound to a different execution');
  }
  if (payload.epoch !== context.epoch) {
    reasons.push('evidence is stale for the current admission epoch');
  }

  return { accepted: reasons.length === 0, reasons };
}

export function admit(
  descriptor: SubstrateDescriptor,
  evidence: SignedEvidence | null,
  requirement: ObligationRequirement,
  context: AdmissionContext,
  trustRoots: TrustRoots,
): AdmissionDecision {
  if (requirement.providerEffect === 'unconstrained') {
    return { accepted: true, reasons: [] };
  }
  if (!evidence) {
    return { accepted: false, reasons: ['required capability evidence is absent'] };
  }

  const verified = verifyEvidence(evidence, descriptor, requirement, context, trustRoots);
  if (!verified.accepted) return verified;

  const satisfies = evidence.guarantee === 'controlled-isolation';

  if (satisfies) return { accepted: true, reasons: [] };
  if (evidence.guarantee === 'observed-absent') {
    return {
      accepted: false,
      reasons: [
        'point observation of capability absence is informative but not admission-authorizing',
      ],
    };
  }
  return {
    accepted: false,
    reasons: ['trusted evidence does not satisfy the required guarantee'],
  };
}

export function naiveDescriptorAdmission(
  descriptor: SubstrateDescriptor,
  requirement: ObligationRequirement,
): boolean {
  if (requirement.providerEffect === 'unconstrained') return true;
  if (requirement.providerEffect === 'controlled-isolation') {
    return descriptor.claims.providerEffect === 'isolated';
  }
  return descriptor.claims.providerEffect !== 'ambient-write';
}

export function admissionMatrix(
  fixtures: SubstrateDescriptor[],
  evidenceByFixture: Map<string, SignedEvidence>,
  obligations: ObligationRequirement[],
  context: AdmissionContext,
  trustRoots: TrustRoots,
): Record<string, Record<string, boolean>> {
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const obligation of obligations) {
    matrix[obligation.id] = {};
    for (const fixture of fixtures) {
      matrix[obligation.id][fixture.id] = admit(
        fixture,
        evidenceByFixture.get(fixture.id) ?? null,
        obligation,
        context,
        trustRoots,
      ).accepted;
    }
  }
  return matrix;
}
