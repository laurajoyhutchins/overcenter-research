import { createHash } from 'node:crypto';
import type { Postcondition } from './model.ts';
import { githubStatusContextKey } from './providers/github-status.ts';

export interface EffectSemantics {
  resource:string;
  desired:string;
  sameDesiredCommutes:boolean;
}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function digest(value:unknown):string {
  const canonical=(input:unknown):unknown=>{
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input==='object') {
      return Object.fromEntries(
        Object.entries(input as Record<string,unknown>)
          .sort(([a],[b])=>a.localeCompare(b))
          .map(([key,item])=>[key,canonical(item)]),
      );
    }
    return input;
  };
  return sha256(JSON.stringify(canonical(value)));
}

export function verifiedContentIdentity(postcondition:Postcondition):string|null {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return `sha256:${sha256(postcondition.content)}`;
  }
  if (postcondition.verifier==='github-commit-status/v1') {
    return digest({
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
  if (postcondition.verifier!=='github-commit-status/v1') return null;
  return {
    resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desired:postcondition.expected_state,
    sameDesiredCommutes:true,
  };
}

export function semanticDigest(value:unknown):string {
  return digest(value);
}
