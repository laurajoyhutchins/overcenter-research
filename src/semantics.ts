import type { Postcondition } from './model.ts';
import { canonicalDigest, sha256 } from './digest.ts';
import { githubStatusContextKey } from './providers/github-status.ts';

export interface EffectConflictSemantics {
  resource:string;
  desired:string;
  sameDesiredCommutes:boolean;
}

export function verifiedRealizationIdentity(postcondition:Postcondition):string|null {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return `sha256:${sha256(postcondition.content)}`;
  }
  if (postcondition.verifier==='github-commit-status/v1') {
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
  if (postcondition.verifier!=='github-commit-status/v1') return null;
  return {
    resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desired:postcondition.expected_state,
    sameDesiredCommutes:true,
  };
}
