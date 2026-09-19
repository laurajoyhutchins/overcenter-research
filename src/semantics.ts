import type { Postcondition } from './model.ts';
import { canonicalDigest, sha256 } from './digest.ts';
import {
  githubCommitStatusEffectEquivalenceWitness,
  githubCommitStatusEffectSemantics,
  githubCommitStatusSettlementSemantics,
} from './providers/github-semantics.ts';
import { githubStatusContextKey } from './providers/github-rest.ts';
import { LOCAL_FILE_ENOENT_EVIDENCE } from './evidence.ts';
import { KUBERNETES_COMPLETE_LIST_ABSENCE } from './providers/kubernetes-configmap.ts';
import type {
  EffectEquivalenceWitness,
  EffectSemantics,
  SettlementSemantics,
} from './semantics-contract.ts';

export type {
  EffectEquivalenceWitness,
  EffectSemantics,
  SettlementSemantics,
} from './semantics-contract.ts';

export function settlementSemantics(postcondition:Postcondition):SettlementSemantics {
  if (postcondition.verifier==='file-content-equals/v1') {
    return {
      verifier:postcondition.verifier,
      acceptedAbsenceEvidenceKinds:[LOCAL_FILE_ENOENT_EVIDENCE],
    };
  }
  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    return {
      verifier:postcondition.verifier,
      acceptedAbsenceEvidenceKinds:[KUBERNETES_COMPLETE_LIST_ABSENCE],
    };
  }
  if (postcondition.verifier==='eventually-consistent-file-content-equals/v1') {
    return {
      verifier:postcondition.verifier,
      acceptedAbsenceEvidenceKinds:[],
    };
  }
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return githubCommitStatusSettlementSemantics(postcondition);
  }
  const exhaustive:never=postcondition;
  throw new Error(`UNSUPPORTED_SETTLEMENT_SEMANTICS:${String(exhaustive)}`);
}

export function verifiedContentIdentity(postcondition:Postcondition):string|null {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return `sha256:${sha256(postcondition.content)}`;
  }
  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    return canonicalDigest({
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      api_group:postcondition.api_group,
      resource:postcondition.resource,
      namespace:postcondition.namespace,
      name:postcondition.name,
      state:'exists',
    });
  }
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return canonicalDigest({
      provider:'github',
      repository_id:postcondition.repository_id,
      commit_sha:postcondition.commit_sha,
      context:githubStatusContextKey(postcondition.context),
      state:postcondition.expected_state,
    });
  }
  return null;
}

export function effectSemantics(postcondition:Postcondition):EffectSemantics|null {
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return githubCommitStatusEffectSemantics(postcondition);
  }
  return null;
}

export function effectEquivalenceWitness(
  postcondition:Postcondition,
):EffectEquivalenceWitness|null {
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return githubCommitStatusEffectEquivalenceWitness(postcondition);
  }
  return null;
}

export function validateEffectEquivalenceWitness(
  postcondition:Postcondition,
  witness:EffectEquivalenceWitness,
):boolean {
  const expected=effectEquivalenceWitness(postcondition);
  if (!expected) return false;
  return canonicalDigest(expected)===canonicalDigest(witness);
}

export function effectEquivalenceWitnessesAuthorizeUnorderedOverlap(
  left:Postcondition,
  right:Postcondition,
):boolean {
  const leftWitness=effectEquivalenceWitness(left);
  const rightWitness=effectEquivalenceWitness(right);
  return Boolean(
    leftWitness
    && rightWitness
    && leftWitness.certificate_digest===rightWitness.certificate_digest,
  );
}
