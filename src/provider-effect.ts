import type { Work } from './model.ts';
import { canonicalDigest } from './digest.ts';
import { GITHUB_COMMIT_STATUS_EFFECT_CONTRACT } from './effect-authority.ts';
import {
  GITHUB_COMMIT_STATUS_ADAPTER_CONTRACT_DIGEST,
  deriveGithubCommitStatusEffect,
  executeGithubCommitStatusEffect,
  type GithubCommitStatusAttemptEvidence,
  type GithubCommitStatusEffect,
} from './providers/github-effect.ts';

export type ProviderEffect=GithubCommitStatusEffect;
export type ProviderEffectAttemptEvidence=GithubCommitStatusAttemptEvidence;

export interface AuthorizedProviderEffect {
  effect_contract:string;
  adapter_contract_digest:string;
  effect_digest:string;
  effect:ProviderEffect;
}

export interface ProviderEffectExecutionContext {
  githubToken?:string;
  githubFetch?:typeof fetch;
}

export function deriveAuthorizedProviderEffect(
  work:Work,
):AuthorizedProviderEffect|null {
  const authority=work.effect_authority;
  if (!authority) return null;

  if (authority.contract===GITHUB_COMMIT_STATUS_EFFECT_CONTRACT) {
    const effect=deriveGithubCommitStatusEffect(work.postcondition);
    if (!effect) throw new Error('EFFECT_AUTHORITY_POSTCONDITION_MISMATCH');
    const payload={
      effect_contract:authority.contract,
      adapter_contract_digest:GITHUB_COMMIT_STATUS_ADAPTER_CONTRACT_DIGEST,
      effect,
    };
    return {
      ...payload,
      effect_digest:canonicalDigest(payload),
    };
  }

  const exhaustive:never=authority;
  throw new Error(`UNSUPPORTED_EFFECT_AUTHORITY:${String(exhaustive)}`);
}

export async function executeAuthorizedProviderEffect(
  authorized:AuthorizedProviderEffect,
  context:ProviderEffectExecutionContext,
):Promise<ProviderEffectAttemptEvidence> {
  if (authorized.effect.provider==='github') {
    if (!context.githubToken) throw new Error('GITHUB_EFFECT_TOKEN_MISSING');
    return executeGithubCommitStatusEffect(authorized.effect,{
      token:context.githubToken,
      fetch:context.githubFetch,
    });
  }

  const exhaustive:never=authorized.effect;
  throw new Error(`UNSUPPORTED_PROVIDER_EFFECT:${String(exhaustive)}`);
}
