import type { Postcondition } from './model.ts';
import { canonicalDigest, sha256 } from './digest.ts';
import { githubStatusContextKey } from './providers/github-rest.ts';
import { LOCAL_FILE_ENOENT_EVIDENCE } from './evidence.ts';

export interface EffectConflictSemantics {
  coordinate:string;
  desiredState:string;
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
  if (
    postcondition.verifier==='eventually-consistent-file-content-equals/v1'
    || postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return {
      verifier:postcondition.verifier,
      acceptedAbsenceEvidenceKinds:[],
    };
  }
  const exhaustive:never=postcondition;
  throw new Error(`UNSUPPORTED_SETTLEMENT_SEMANTICS:${String(exhaustive)}`);
}

export function verifiedRealizationIdentity(postcondition:Postcondition):string|null {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return `sha256:${sha256(postcondition.content)}`;
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

export function effectConflictSemantics(postcondition:Postcondition):EffectConflictSemantics|null {
  if (
    postcondition.verifier!=='github-commit-status/v1'
    && postcondition.verifier!=='github-commit-status/v2'
  ) return null;
  return {
    coordinate:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desiredState:postcondition.expected_state,
    sameDesiredCommutes:true,
  };
}
