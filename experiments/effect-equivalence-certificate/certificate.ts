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

type GitHubVerifier =
  | 'github-commit-status/v1'
  | 'github-commit-status/v2';

interface GitHubEquivalenceContract {
  provider:'github';
  verifier_contract:GitHubVerifier;
  coordinate_contract:'github-commit-status-coordinate/v1';
  observation_contract:
    | 'github-commit-status-observation/v1'
    | 'github-commit-status-observation/v2';
  operation_class:'github-commit-status/set-state/v1';
}

export interface EffectEquivalenceCertificatePayload {
  schema:typeof EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA;
  issuer_contract:typeof EFFECT_EQUIVALENCE_ISSUER_CONTRACT;
  provider:'github';
  verifier_contract:GitHubVerifier;
  coordinate_contract:'github-commit-status-coordinate/v1';
  observation_contract:GitHubEquivalenceContract['observation_contract'];
  operation_class:'github-commit-status/set-state/v1';
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

function githubEquivalenceContract(
  postcondition:Postcondition,
):GitHubEquivalenceContract|null {
  if (postcondition.verifier==='github-commit-status/v1') {
    return {
      provider:'github',
      verifier_contract:postcondition.verifier,
      coordinate_contract:'github-commit-status-coordinate/v1',
      observation_contract:'github-commit-status-observation/v1',
      operation_class:'github-commit-status/set-state/v1',
    };
  }

  if (postcondition.verifier==='github-commit-status/v2') {
    return {
      provider:'github',
      verifier_contract:postcondition.verifier,
      coordinate_contract:'github-commit-status-coordinate/v1',
      observation_contract:'github-commit-status-observation/v2',
      operation_class:'github-commit-status/set-state/v1',
    };
  }

  return null;
}

function payloadFor(
  postcondition:Postcondition,
):EffectEquivalenceCertificatePayload|null {
  const contract=githubEquivalenceContract(postcondition);
  if (!contract) return null;

  const effect=effectSemantics(postcondition);
  if (!effect || !effect.sameDesiredCommutes) return null;

  const settlement=settlementSemantics(postcondition);

  return {
    schema:EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA,
    issuer_contract:EFFECT_EQUIVALENCE_ISSUER_CONTRACT,
    ...contract,
    resource:effect.resource,
    operation:effect.desired,
    equivalence_class:'same-desired-under-overcenter-settlement',
    effect_semantics_digest:canonicalDigest({
      contract,
      effect,
    }),
    settlement_semantics_digest:canonicalDigest({
      contract,
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
  // provider contract. Cross-version equivalence must be separately
  // established rather than inherited from a boolean.
  return (
    leftCertificate.provider===rightCertificate.provider
    && leftCertificate.verifier_contract===rightCertificate.verifier_contract
    && leftCertificate.coordinate_contract===rightCertificate.coordinate_contract
    && leftCertificate.observation_contract===rightCertificate.observation_contract
    && leftCertificate.operation_class===rightCertificate.operation_class
    && leftCertificate.resource===rightCertificate.resource
    && leftCertificate.operation===rightCertificate.operation
    && leftCertificate.equivalence_class===rightCertificate.equivalence_class
    && leftCertificate.effect_semantics_digest===rightCertificate.effect_semantics_digest
    && leftCertificate.settlement_semantics_digest===rightCertificate.settlement_semantics_digest
  );
}
