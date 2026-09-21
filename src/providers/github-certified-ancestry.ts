import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import { GITHUB_COMPARE_COMMITS_OPERATION } from './github-operations.generated.ts';
import { materializeGithubOperationRequest } from './github-openapi.ts';
import { observeCertifiedGithubRead200 } from './github-certified-observation.ts';
import { GITHUB_COMPARE_COMMITS_RESPONSE_SLICE } from './github-semantics.ts';
import {
  isGithubObjectId,
  sameGithubObjectId,
  type GithubJsonGet,
} from './github-rest.ts';
import { githubRepositoryCoordinate } from './github-certified-repository.ts';

export interface CertifiedGithubCommitAncestryEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-pull-request-branch-updated/v1'};
  operation_id:'repos/compare-commits';
  observed_at:string;
  requested_repository_full_name:string;
  request_path:string;
  ancestor_sha:string;
  descendant_sha:string;
  status:'ahead'|'behind'|'diverged'|'identical';
  ahead_by:number;
  behind_by:number;
  merge_base_sha:string;
  relation:'ancestor'|'not-ancestor';
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubCommitAncestryResult {
  state:'ancestor'|'not-ancestor';
  evidence:CertifiedGithubCommitAncestryEvidence;
}

export function observeCertifiedGithubCommitAncestry(
  token:string,
  {
    repositoryFullName,
    ancestorSha,
    descendantSha,
    get,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryFullName:string;
    ancestorSha:string;
    descendantSha:string;
    get:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubCommitAncestryResult {
  if (!isGithubObjectId(ancestorSha) || !isGithubObjectId(descendantSha)) {
    throw new Error('GITHUB_COMMIT_ANCESTRY_SHA_INVALID');
  }
  const {owner,repo}=githubRepositoryCoordinate(repositoryFullName);
  const request=materializeGithubOperationRequest(
    GITHUB_COMPARE_COMMITS_OPERATION,
    {owner,repo,basehead:`${ancestorSha}...${descendantSha}`},
  );
  const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
    token,
    operation:GITHUB_COMPARE_COMMITS_OPERATION,
    request,
    fields:GITHUB_COMPARE_COMMITS_RESPONSE_SLICE,
    get,
    clock,
    observerId:'github-pull-request-branch-updated/v1',
  });
  const value=certified.outcome.value as {
    status:'ahead'|'behind'|'diverged'|'identical';
    ahead_by:number;
    behind_by:number;
    base_commit:{sha:string};
    merge_base_commit:{sha:string};
  };
  if (
    !['ahead','behind','diverged','identical'].includes(value.status)
    || !Number.isSafeInteger(value.ahead_by)
    || value.ahead_by<0
    || !Number.isSafeInteger(value.behind_by)
    || value.behind_by<0
    || !isGithubObjectId(value.base_commit?.sha)
    || !sameGithubObjectId(value.base_commit.sha,ancestorSha)
    || !isGithubObjectId(value.merge_base_commit?.sha)
  ) {
    throw new Error('GITHUB_COMMIT_ANCESTRY_OBSERVATION_INVALID');
  }
  const relation=(
    (value.status==='ahead' || value.status==='identical')
    && value.behind_by===0
    && sameGithubObjectId(value.merge_base_commit.sha,ancestorSha)
  ) ? 'ancestor' as const : 'not-ancestor' as const;
  return {
    state:relation,
    evidence:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-pull-request-branch-updated/v1'},
      operation_id:'repos/compare-commits',
      observed_at:observedAt,
      requested_repository_full_name:repositoryFullName,
      request_path:request.path,
      ancestor_sha:ancestorSha,
      descendant_sha:descendantSha,
      status:value.status,
      ahead_by:value.ahead_by,
      behind_by:value.behind_by,
      merge_base_sha:value.merge_base_commit.sha,
      relation,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    },
  };
}
