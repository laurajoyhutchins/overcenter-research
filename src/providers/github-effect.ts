import type {
  GitHubCommitStatusPostcondition,
  Postcondition,
} from '../model.ts';
import { canonicalDigest } from '../digest.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import { GITHUB_COMMIT_STATUS_EFFECT_CONTRACT } from '../effect-authority.ts';

export interface GithubCommitStatusEffect {
  provider:'github';
  operation:'create-commit-status';
  repository_id:number;
  commit_sha:string;
  context:string;
  state:'error'|'failure'|'pending'|'success';
}

export interface GithubCommitStatusAttemptEvidence {
  provider:'github';
  operation:'create-commit-status';
  repository_id:number;
  repository_full_name:string;
  commit_sha:string;
  context:string;
  state:'error'|'failure'|'pending'|'success';
  provider_status_id:number;
}

export interface GithubEffectExecutionContext {
  token:string;
  fetch?:typeof fetch;
}

export const GITHUB_COMMIT_STATUS_ADAPTER_CONTRACT_DIGEST=canonicalDigest({
  effect_contract:GITHUB_COMMIT_STATUS_EFFECT_CONTRACT,
  api_version:GITHUB_API_VERSION,
  openapi_sha256:GITHUB_OPENAPI_SHA256,
  openapi_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
  method:'POST',
  path_template:'/repos/{owner}/{repo}/statuses/{sha}',
  request_semantics:{
    state:'postcondition.expected_state',
    context:'postcondition.context',
  },
});

export function deriveGithubCommitStatusEffect(
  postcondition:Postcondition,
):GithubCommitStatusEffect|null {
  if (
    postcondition.verifier!=='github-commit-status/v1'
    && postcondition.verifier!=='github-commit-status/v2'
  ) {
    return null;
  }

  return githubEffectFromPostcondition(postcondition);
}

function githubEffectFromPostcondition(
  postcondition:GitHubCommitStatusPostcondition,
):GithubCommitStatusEffect {
  return {
    provider:'github',
    operation:'create-commit-status',
    repository_id:postcondition.repository_id,
    commit_sha:postcondition.commit_sha,
    context:postcondition.context,
    state:postcondition.expected_state,
  };
}

export async function executeGithubCommitStatusEffect(
  effect:GithubCommitStatusEffect,
  {
    token,
    fetch:fetchImpl=fetch,
  }:GithubEffectExecutionContext,
):Promise<GithubCommitStatusAttemptEvidence> {
  const headers={
    Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':GITHUB_API_VERSION,
    'Content-Type':'application/json',
  };

  const repositoryResponse=await fetchImpl(
    `https://api.github.com/repositories/${effect.repository_id}`,
    {headers},
  );
  if (!repositoryResponse.ok) {
    throw new Error(
      `GITHUB_EFFECT_REPOSITORY_IDENTITY_FAILED:${repositoryResponse.status}:${await repositoryResponse.text()}`,
    );
  }

  const repository=await repositoryResponse.json() as {
    id:number;
    full_name:string;
  };
  if (
    repository.id!==effect.repository_id
    || typeof repository.full_name!=='string'
    || repository.full_name.length===0
  ) {
    throw new Error('GITHUB_EFFECT_REPOSITORY_IDENTITY_MISMATCH');
  }

  const response=await fetchImpl(
    `https://api.github.com/repos/${repository.full_name}/statuses/${effect.commit_sha}`,
    {
      method:'POST',
      headers,
      body:JSON.stringify({
        state:effect.state,
        context:effect.context,
        description:'Overcenter authorized effect broker',
      }),
    },
  );
  if (response.status!==201) {
    throw new Error(
      `GITHUB_EFFECT_MUTATION_FAILED:${response.status}:${await response.text()}`,
    );
  }

  const created=await response.json() as {
    id:number;
    state:string;
    context:string;
  };
  if (
    !Number.isSafeInteger(created.id)
    || created.id<=0
    || created.state!==effect.state
    || created.context.toLowerCase()!==effect.context.toLowerCase()
  ) {
    throw new Error('GITHUB_EFFECT_RESPONSE_MISMATCH');
  }

  return {
    provider:'github',
    operation:'create-commit-status',
    repository_id:effect.repository_id,
    repository_full_name:repository.full_name,
    commit_sha:effect.commit_sha,
    context:effect.context,
    state:effect.state,
    provider_status_id:created.id,
  };
}
