import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import { GITHUB_COMMIT_STATUSES_OPERATION } from './github-operations.generated.ts';
import { scanGithubPageCollection } from './github-page-collection.ts';
import { GITHUB_COMMIT_STATUS_RESPONSE_SLICE } from './github-semantics.ts';
import {
  observeCertifiedGithubRepository,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import { observeCertifiedGithubRead200 } from './github-certified-read.ts';
import {
  githubGet,
  githubStatusContextKey,
  type GithubJsonGet,
} from './github-rest.ts';

export interface CertifiedGithubStatusPageEvidence {
  page:number;
  member_count:number;
  observed_at:string;
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
  repository:CertifiedGithubRepositoryEvidence;
  commit_sha:string;
  status_operation_id:'repos/list-commit-statuses-for-ref';
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

function certifiedMembers(
  certified:ReturnType<typeof observeCertifiedGithubRead200>['certified'],
):{
  members:StatusMember[];
  validated_paths:string[];
  optional_absent_paths:string[];
} {
  const members=certified.outcome.value as StatusMember[];
  for (const member of members) {
    if (member.id<=0 || member.node_id.length===0) {
      throw new Error('GITHUB_STATUS_IDENTITY_INVALID');
    }
    if (!['error','failure','pending','success'].includes(member.state)) {
      throw new Error('GITHUB_STATUS_STATE_INVALID');
    }
  }
  return {
    members,
    validated_paths:certified.structural_validation.validated_paths,
    optional_absent_paths:certified.structural_validation.optional_absent_paths,
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
      evidence:{
        provider:'github',
        api_version:GITHUB_API_VERSION,
        schema_sha256:GITHUB_OPENAPI_SHA256,
        schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
        observer:{kind:'git-kernel',id:'github-commit-status/v2'},
        repository_id:repositoryId,
        requested_repository_full_name:repositoryFullName,
        repository:repository.evidence,
        commit_sha:commitSha,
        status_operation_id:'repos/list-commit-statuses-for-ref',
        pages,
      },
    };
  }

  return {
    state:'indeterminate',
    reason:scan.state==='limit-reached'
      ? 'COLLECTION_SCAN_LIMIT_REACHED'
      : 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE',
    repository_full_name:canonicalFullName,
    evidence:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-commit-status/v2'},
      repository_id:repositoryId,
      requested_repository_full_name:repositoryFullName,
      repository:repository.evidence,
      commit_sha:commitSha,
      status_operation_id:'repos/list-commit-statuses-for-ref',
      pages,
    },
  };
}

export { GITHUB_COMMIT_STATUSES_OPERATION } from './github-operations.generated.ts';
export { GITHUB_COMMIT_STATUS_RESPONSE_SLICE } from './github-semantics.ts';
export {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
export type { GithubJsonGet } from './github-rest.ts';
