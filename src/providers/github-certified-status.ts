import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import {
  GITHUB_COMBINED_COMMIT_STATUS_OPERATION,
  GITHUB_COMMIT_STATUSES_OPERATION,
} from './github-operations.generated.ts';
import { materializeGithubOperationRequest } from './github-openapi.ts';
import { scanGithubPageCollection } from './github-page-collection.ts';
import {
  GITHUB_COMBINED_COMMIT_STATUS_RESPONSE_SLICE,
  GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
} from './github-semantics.ts';
import {
  githubRepositoryCoordinate,
  observeCertifiedGithubRepository,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import { observeCertifiedGithubRead200 } from './github-certified-observation.ts';
import {
  githubGet,
  githubStatusContextKey,
  sameGithubObjectId,
  type GithubJsonGet,
} from './github-rest.ts';

export interface CertifiedGithubStatusPageEvidence {
  page:number;
  member_count:number;
  observed_at:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

interface CombinedRepositoryEvidence {
  operation_id:'repos/get-combined-status-for-ref';
  observed_at:string;
  node_id:string;
  canonical_full_name:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubStatusEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-commit-status/v2'};
  repository_id:number;
  requested_repository_full_name:string;
  repository:CertifiedGithubRepositoryEvidence|CombinedRepositoryEvidence;
  commit_sha:string;
  status_operation_id:
    |'repos/get-combined-status-for-ref'
    |'repos/list-commit-statuses-for-ref';
  pages:CertifiedGithubStatusPageEvidence[];
}

export interface CertifiedGithubCommitStatusResult {
  state:'present'|'indeterminate';
  reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES'|'COLLECTION_ABSENCE_NOT_AUTHORITATIVE'|'COLLECTION_SCAN_LIMIT_REACHED';
  repository_full_name:string;
  actual_state?:'error'|'failure'|'pending'|'success';
  evidence:CertifiedGithubStatusEvidence;
}

interface StatusMember {
  id:number;
  node_id:string;
  state:'error'|'failure'|'pending'|'success';
  context:string;
  target_url:string|null;
  created_at:string;
  updated_at:string;
}

interface CombinedStatus {
  sha:string;
  total_count:number;
  repository:{
    id:number;
    node_id:string;
    full_name:string;
    name:string;
    owner:{login:string};
  };
  statuses:StatusMember[];
}

function statusEvidence({
  repositoryId,
  repositoryFullName,
  repository,
  commitSha,
  statusOperationId,
  pages,
}:{
  repositoryId:number;
  repositoryFullName:string;
  repository:CertifiedGithubRepositoryEvidence|CombinedRepositoryEvidence;
  commitSha:string;
  statusOperationId:CertifiedGithubStatusEvidence['status_operation_id'];
  pages:CertifiedGithubStatusPageEvidence[];
}):CertifiedGithubStatusEvidence {
  return {
    provider:'github',
    api_version:GITHUB_API_VERSION,
    schema_sha256:GITHUB_OPENAPI_SHA256,
    schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
    observer:{kind:'git-kernel',id:'github-commit-status/v2'},
    repository_id:repositoryId,
    requested_repository_full_name:repositoryFullName,
    repository,
    commit_sha:commitSha,
    status_operation_id:statusOperationId,
    pages,
  };
}

function validateMembers(members:StatusMember[]):void {
  for (const member of members) {
    if (member.id<=0 || member.node_id.length===0) {
      throw new Error('GITHUB_STATUS_IDENTITY_INVALID');
    }
    if (!['error','failure','pending','success'].includes(member.state)) {
      throw new Error('GITHUB_STATUS_STATE_INVALID');
    }
  }
}

function certifiedMembers(
  certified:ReturnType<typeof observeCertifiedGithubRead200>['certified'],
):{
  members:StatusMember[];
  validated_paths:string[];
  optional_absent_paths:string[];
} {
  const members=certified.outcome.value as StatusMember[];
  validateMembers(members);
  return {
    members,
    validated_paths:certified.structural_validation.validated_paths,
    optional_absent_paths:certified.structural_validation.optional_absent_paths,
  };
}

function observeCombinedPositive(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    commitSha,
    context,
    get,
    clock,
  }:{
    repositoryId:number;
    repositoryFullName:string;
    commitSha:string;
    context:string;
    get:GithubJsonGet;
    clock:()=>string;
  },
):CertifiedGithubCommitStatusResult|null {
  const {owner,repo}=githubRepositoryCoordinate(repositoryFullName);
  const pagination=GITHUB_COMBINED_COMMIT_STATUS_OPERATION.pagination;
  if (!pagination) throw new Error('GITHUB_COMBINED_STATUS_PAGINATION_UNAVAILABLE');
  const request=materializeGithubOperationRequest(
    GITHUB_COMBINED_COMMIT_STATUS_OPERATION,
    {
      owner,
      repo,
      ref:commitSha,
      [pagination.page_parameter]:pagination.first_page,
      [pagination.page_size_parameter]:100,
    },
  );
  const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
    token,
    operation:GITHUB_COMBINED_COMMIT_STATUS_OPERATION,
    request,
    fields:GITHUB_COMBINED_COMMIT_STATUS_RESPONSE_SLICE,
    get,
    clock,
    observerId:'github-commit-status/v2',
  });
  const value=certified.outcome.value as CombinedStatus;
  if (!sameGithubObjectId(value.sha,commitSha)) {
    throw new Error('GITHUB_STATUS_COMMIT_IDENTITY_MISMATCH');
  }

  const repository=value.repository;
  if (repository.id<=0 || repository.node_id.length===0) {
    throw new Error('GITHUB_REPOSITORY_OBSERVATION_INVALID');
  }
  if (
    repository.owner.login.toLowerCase()!==owner.toLowerCase()
    || repository.name.toLowerCase()!==repo.toLowerCase()
    || repository.full_name.toLowerCase()!==`${repository.owner.login}/${repository.name}`.toLowerCase()
  ) {
    throw new Error('GITHUB_REPOSITORY_COORDINATE_MISMATCH');
  }
  if (repository.id!==repositoryId) {
    throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  }

  validateMembers(value.statuses);
  const target=githubStatusContextKey(context);
  const match=value.statuses.find(
    member=>githubStatusContextKey(member.context)===target,
  );
  if (!match) return null;

  const validatedPaths=certified.structural_validation.validated_paths;
  const optionalAbsentPaths=certified.structural_validation.optional_absent_paths;
  const repositoryEvidence:CombinedRepositoryEvidence={
    operation_id:'repos/get-combined-status-for-ref',
    observed_at:observedAt,
    node_id:repository.node_id,
    canonical_full_name:repository.full_name,
    validated_paths:validatedPaths,
    optional_absent_paths:optionalAbsentPaths,
  };
  const pages:[CertifiedGithubStatusPageEvidence]=[{
    page:pagination.first_page,
    member_count:value.statuses.length,
    observed_at:observedAt,
    validated_paths:validatedPaths,
    optional_absent_paths:optionalAbsentPaths,
  }];

  return {
    state:'present',
    reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES',
    repository_full_name:repository.full_name,
    actual_state:match.state,
    evidence:statusEvidence({
      repositoryId,
      repositoryFullName,
      repository:repositoryEvidence,
      commitSha,
      statusOperationId:'repos/get-combined-status-for-ref',
      pages,
    }),
  };
}

function observePaginatedGithubCommitStatus(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    commitSha,
    context,
    get,
    clock,
  }:{
    repositoryId:number;
    repositoryFullName:string;
    commitSha:string;
    context:string;
    get:GithubJsonGet;
    clock:()=>string;
  },
):CertifiedGithubCommitStatusResult {
  const repository=observeCertifiedGithubRepository(token,{
    repositoryId,
    repositoryFullName,
    get,
    clock,
    observerId:'github-commit-status/v2',
  });

  const {owner,repo}=repository.fact.object;
  const canonicalFullName=repository.fact.object.full_name;
  const target=githubStatusContextKey(context);
  const scan=scanGithubPageCollection<StatusMember,Omit<CertifiedGithubStatusPageEvidence,'page'|'member_count'>>({
    operation:GITHUB_COMMIT_STATUSES_OPERATION,
    parameters:{owner,repo,ref:commitSha},
    readPage:({request})=>{
      const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
        token,
        operation:GITHUB_COMMIT_STATUSES_OPERATION,
        request,
        fields:GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
        get,
        clock,
        observerId:'github-commit-status/v2',
      });
      const members=certifiedMembers(certified);
      return {
        members:members.members,
        evidence:{
          observed_at:observedAt,
          validated_paths:members.validated_paths,
          optional_absent_paths:members.optional_absent_paths,
        },
      };
    },
    matches:member=>githubStatusContextKey(member.context)===target,
  });
  const pages=scan.pages;

  if (scan.state==='matched') {
    return {
      state:'present',
      reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES',
      repository_full_name:canonicalFullName,
      actual_state:scan.match.state,
      evidence:statusEvidence({
        repositoryId,
        repositoryFullName,
        repository:repository.evidence,
        commitSha,
        statusOperationId:'repos/list-commit-statuses-for-ref',
        pages,
      }),
    };
  }

  return {
    state:'indeterminate',
    reason:scan.state==='limit-reached'
      ? 'COLLECTION_SCAN_LIMIT_REACHED'
      : 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE',
    repository_full_name:canonicalFullName,
    evidence:statusEvidence({
      repositoryId,
      repositoryFullName,
      repository:repository.evidence,
      commitSha,
      statusOperationId:'repos/list-commit-statuses-for-ref',
      pages,
    }),
  };
}

export function observeCertifiedGithubCommitStatus(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    commitSha,
    context,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    repositoryFullName:string;
    commitSha:string;
    context:string;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubCommitStatusResult {
  const input={
    repositoryId,
    repositoryFullName,
    commitSha,
    context,
    get,
    clock,
  };
  const combined=observeCombinedPositive(token,input);
  return combined??observePaginatedGithubCommitStatus(token,input);
}

export {
  GITHUB_COMBINED_COMMIT_STATUS_OPERATION,
  GITHUB_COMMIT_STATUSES_OPERATION,
} from './github-operations.generated.ts';
export {
  GITHUB_COMBINED_COMMIT_STATUS_RESPONSE_SLICE,
  GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
} from './github-semantics.ts';
export {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
export type { GithubJsonGet } from './github-rest.ts';
