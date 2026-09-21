import type { Postcondition } from './model.ts';
import { canonicalDigest, sha256 } from './digest.ts';
import { githubStatusContextKey } from './providers/github-rest.ts';
import { LOCAL_FILE_ENOENT_EVIDENCE } from './evidence.ts';
import { KUBERNETES_COMPLETE_LIST_ABSENCE } from './providers/kubernetes-configmap.ts';

export interface EffectSemantics {
  resource:string;
  desired:string;
  sameDesiredCommutes:boolean;
}

export interface SettlementSemantics {
  verifier:Postcondition['verifier'];
  acceptedAbsenceEvidenceKinds:readonly string[];
}

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
  if (
    postcondition.verifier==='eventually-consistent-file-content-equals/v1'
    || postcondition.verifier==='github-commit-status/v2'
    || postcondition.verifier==='github-pull-request-branch-updated/v1'
  ) {
    return {
      verifier:postcondition.verifier,
      acceptedAbsenceEvidenceKinds:[],
    };
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
  if (postcondition.verifier==='github-commit-status/v2') {
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
  if (postcondition.verifier==='github-pull-request-branch-updated/v1') {
    return {
      resource:`github-pr-branch:${postcondition.repository_id}:${postcondition.pull_number}`,
      desired:canonicalDigest({
        previous_head_sha:postcondition.expected_previous_head_sha,
        base_ref:postcondition.base_ref,
        base_sha:postcondition.expected_base_sha,
      }),
      sameDesiredCommutes:false,
    };
  }
  if (postcondition.verifier!=='github-commit-status/v2') return null;
  return {
    resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desired:postcondition.expected_state,
    sameDesiredCommutes:true,
  };
}
