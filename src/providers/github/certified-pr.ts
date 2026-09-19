import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './contract.ts';
import { GITHUB_PULL_REQUEST_OPERATION } from './operations.generated.ts';
import { materializeGithubOperationRequest } from './openapi.ts';
import { GITHUB_PULL_REQUEST_RESPONSE_SLICE } from './semantics.ts';
import {
  observeCertifiedGithubRepository,
  type CertifiedGithubRepositoryEvidence,
} from './certified-repository.ts';
import { observeCertifiedGithubRead200 } from './certified-observation.ts';
import {
  githubGet,
  isGithubObjectId,
  sameGithubObjectId,
  type GithubJsonGet,
} from './rest.ts';

export interface GithubPullRequestExpectedIdentity {
  node_id:string;
  state:string;
  head_sha:string;
  base_ref:string;
  base_sha:string;
}

export interface CertifiedGithubPullRequestEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-pr-identity/v1'};
  repository_id:number;
  requested_repository_full_name:string;
  repository:CertifiedGithubRepositoryEvidence;
  operation_id:'pulls/get';
  observed_at:string;
  pull_number:number;
  pull_id:number;
  node_id:string;
  state:string;
  head_sha:string;
  base_ref:string;
  base_sha:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubPullRequestIdentityResult {
  state:'CURRENT'|'STALE'|'INDETERMINATE';
  reason:'AUTHORITATIVE_PR_IDENTITY_MATCHES'|'AUTHORITATIVE_PR_IDENTITY_DIFFERS'|'OBSERVATION_FAILED';
  repository_full_name?:string;
  pull_number:number;
  expected:GithubPullRequestExpectedIdentity;
  actual?:GithubPullRequestExpectedIdentity & {id:number};
  differences?:string[];
  evidence?:CertifiedGithubPullRequestEvidence;
  observation_error?:string;
}

function validateExpected(expected:GithubPullRequestExpectedIdentity):void {
  if (!expected.node_id) throw new Error('GITHUB_PR_NODE_ID_REQUIRED');
  if (!expected.state) throw new Error('GITHUB_PR_STATE_REQUIRED');
  if (!isGithubObjectId(expected.head_sha)) throw new Error('GITHUB_PR_HEAD_SHA_INVALID');
  if (!expected.base_ref) throw new Error('GITHUB_PR_BASE_REF_REQUIRED');
  if (!isGithubObjectId(expected.base_sha)) throw new Error('GITHUB_PR_BASE_SHA_INVALID');
}

export function observeCertifiedGithubPullRequestIdentity(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    pullNumber,
    expected,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    repositoryFullName:string;
    pullNumber:number;
    expected:GithubPullRequestExpectedIdentity;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubPullRequestIdentityResult {
  if (!Number.isSafeInteger(pullNumber) || pullNumber<=0) {
    throw new Error('GITHUB_PR_NUMBER_INVALID');
  }
  validateExpected(expected);

  try {
    const repository=observeCertifiedGithubRepository(token,{
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId:'github-pr-identity/v1',
    });
    const {owner,repo}=repository.fact.object;
    const request=materializeGithubOperationRequest(GITHUB_PULL_REQUEST_OPERATION,{
      owner,
      repo,
      pull_number:pullNumber,
    });
    const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
      token,
      operation:GITHUB_PULL_REQUEST_OPERATION,
      request,
      fields:GITHUB_PULL_REQUEST_RESPONSE_SLICE,
      get,
      clock,
      observerId:'github-pr-identity/v1',
    });
    const value=certified.outcome.value as {
      id:number;
      node_id:string;
      number:number;
      state:string;
      head:{sha:string};
      base:{ref:string;sha:string};
    };
    if (value.id<=0 || value.node_id.length===0 || value.number!==pullNumber) {
      throw new Error('GITHUB_PR_IDENTITY_INVALID');
    }
    if (!isGithubObjectId(value.head.sha) || !isGithubObjectId(value.base.sha)) {
      throw new Error('GITHUB_PR_REVISION_INVALID');
    }

    const actual={
      id:value.id,
      node_id:value.node_id,
      state:value.state,
      head_sha:value.head.sha,
      base_ref:value.base.ref,
      base_sha:value.base.sha,
    };
    const differences:string[]=[];
    if (actual.node_id!==expected.node_id) differences.push('node_id');
    if (actual.state!==expected.state) differences.push('state');
    if (!sameGithubObjectId(actual.head_sha,expected.head_sha)) differences.push('head_sha');
    if (actual.base_ref!==expected.base_ref) differences.push('base_ref');
    if (!sameGithubObjectId(actual.base_sha,expected.base_sha)) differences.push('base_sha');

    const evidence:CertifiedGithubPullRequestEvidence={
      provider:'github',
      api_version:GITHUB_API_VERSION,
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-pr-identity/v1'},
      repository_id:repositoryId,
      requested_repository_full_name:repositoryFullName,
      repository:repository.evidence,
      operation_id:'pulls/get',
      observed_at:observedAt,
      pull_number:pullNumber,
      pull_id:value.id,
      node_id:value.node_id,
      state:value.state,
      head_sha:value.head.sha,
      base_ref:value.base.ref,
      base_sha:value.base.sha,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    };

    return {
      state:differences.length===0?'CURRENT':'STALE',
      reason:differences.length===0?'AUTHORITATIVE_PR_IDENTITY_MATCHES':'AUTHORITATIVE_PR_IDENTITY_DIFFERS',
      repository_full_name:repository.fact.object.full_name,
      pull_number:pullNumber,
      expected,
      actual,
      differences,
      evidence,
    };
  } catch (error:unknown) {
    return {
      state:'INDETERMINATE',
      reason:'OBSERVATION_FAILED',
      pull_number:pullNumber,
      expected,
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}

export { GITHUB_PULL_REQUEST_OPERATION } from './operations.generated.ts';
export { GITHUB_PULL_REQUEST_RESPONSE_SLICE } from './semantics.ts';
