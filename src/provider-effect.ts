import type { Work } from './model.ts';
import {
  deriveGithubCommitStatusEffect,
  executeGithubCommitStatusEffect,
  type GithubCommitStatusAttemptEvidence,
  type GithubCommitStatusEffect,
} from './providers/github-effect.ts';

export type AuthorizedProviderEffect=GithubCommitStatusEffect;
export type ProviderEffectAttemptEvidence=GithubCommitStatusAttemptEvidence;

export interface ProviderEffectExecutionContext {
  githubToken?:string;
  githubFetch?:typeof fetch;
}

export function deriveAuthorizedProviderEffect(
  work:Work,
):AuthorizedProviderEffect|null {
  return deriveGithubCommitStatusEffect(work.postcondition);
}

export async function executeAuthorizedProviderEffect(
  effect:AuthorizedProviderEffect,
  context:ProviderEffectExecutionContext,
):Promise<ProviderEffectAttemptEvidence> {
  if (effect.provider==='github') {
    if (!context.githubToken) throw new Error('GITHUB_EFFECT_TOKEN_MISSING');
    return executeGithubCommitStatusEffect(effect,{
      token:context.githubToken,
      fetch:context.githubFetch,
    });
  }

  const exhaustive:never=effect;
  throw new Error(`UNSUPPORTED_PROVIDER_EFFECT:${String(exhaustive)}`);
}
