import type { Postcondition } from '../../src/model.ts';
import { canonicalDigest } from '../../src/digest.ts';
import {
  effectSemantics,
  settlementSemantics,
} from '../../src/semantics.ts';

export const EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA =
  'overcenter-effect-equivalence-certificate-v1' as const;

export const EFFECT_EQUIVALENCE_ISSUER_CONTRACT =
  'overcenter/provider-effect-equivalence-issuer/v1' as const;

export interface EffectEquivalenceCertificatePayload {
  schema:typeof EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA;
  issuer_contract:typeof EFFECT_EQUIVALENCE_ISSUER_CONTRACT;
  provider:'github';
  verifier_contract:'github-commit-status/v1'|'github-commit-status/v2';
  resource:string;
  operation:string;
  equivalence_class:'same-desired-under-overcenter-settlement';
  effect_semantics_digest:string;
  settlement_semantics_digest:string;
}

export interface EffectEquivalenceCertificate
  extends EffectEquivalenceCertificatePayload {
  certificate_digest:string;
}

function githubProvider(
  postcondition:Postcondition,
):'github'|null {
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) return 'github';
  return null;
}

function payloadFor(
  postcondition:Postcondition,
):EffectEquivalenceCertificatePayload|null {
  const provider=githubProvider(postcondition);
  if (!provider) return null;

  const effect=effectSemantics(postcondition);
  if (!effect || !effect.sameDesiredCommutes) return null;

  const settlement=settlementSemantics(postcondition);

  return {
    schema:EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA,
    issuer_contract:EFFECT_EQUIVALENCE_ISSUER_CONTRACT,
    provider,
    verifier_contract:postcondition.verifier,
    resource:effect.resource,
    operation:effect.desired,
    equivalence_class:'same-desired-under-overcenter-settlement',
    effect_semantics_digest:canonicalDigest({
      verifier:postcondition.verifier,
      effect,
    }),
    settlement_semantics_digest:canonicalDigest({
      verifier:postcondition.verifier,
      settlement,
    }),
  };
}

export function issueEffectEquivalenceCertificate(
  postcondition:Postcondition,
):EffectEquivalenceCertificate|null {
  const payload=payloadFor(postcondition);
  if (!payload) return null;
  return {
    ...payload,
    certificate_digest:canonicalDigest(payload),
  };
}

export function validateEffectEquivalenceCertificate(
  postcondition:Postcondition,
  certificate:EffectEquivalenceCertificate,
):boolean {
  const expected=issueEffectEquivalenceCertificate(postcondition);
  if (!expected) return false;
  return canonicalDigest(expected)===canonicalDigest(certificate);
}

export function certificatesAuthorizeUnorderedOverlap(
  leftPostcondition:Postcondition,
  leftCertificate:EffectEquivalenceCertificate,
  rightPostcondition:Postcondition,
  rightCertificate:EffectEquivalenceCertificate,
):boolean {
  if (
    !validateEffectEquivalenceCertificate(leftPostcondition,leftCertificate)
    || !validateEffectEquivalenceCertificate(rightPostcondition,rightCertificate)
  ) return false;

  // Same-coordinate concurrency is admitted only under the exact same
  // provider/verifier contract. Cross-version equivalence must be separately
  // established rather than inherited from a boolean.
  return (
    leftCertificate.provider===rightCertificate.provider
    && leftCertificate.verifier_contract===rightCertificate.verifier_contract
    && leftCertificate.resource===rightCertificate.resource
    && leftCertificate.operation===rightCertificate.operation
    && leftCertificate.equivalence_class===rightCertificate.equivalence_class
    && leftCertificate.effect_semantics_digest===rightCertificate.effect_semantics_digest
    && leftCertificate.settlement_semantics_digest===rightCertificate.settlement_semantics_digest
  );
}
