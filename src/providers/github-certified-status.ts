import {
  validateObservationSlice,
  type ResponseFieldSpec,
} from '../provider-observation/response-slice.ts';
import { GITHUB_API_VERSION, GITHUB_OPENAPI_SHA256, GITHUB_OPENAPI_SOURCE_COMMIT } from './github-contract.ts';
import {
  observeCertifiedGithubRepositoryIdentity,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import {
  githubRawObservation,
  type GithubReadOperation,
} from './github-observation.ts';
import { githubGet, githubStatusContextKey, type GithubJsonGet } from './github-status.ts';

export { GITHUB_API_VERSION, GITHUB_OPENAPI_SHA256, GITHUB_OPENAPI_SOURCE_COMMIT } from './github-contract.ts';

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
  operation_id:'repos/list-commit-statuses-for-ref';
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-commit-status/v1'};
  repository_id:number;
  repository_full_name:string;
  commit_sha:string;
  repository_identity:CertifiedGithubRepositoryEvidence;
  pages:CertifiedGithubStatusPageEvidence[];
}

export interface CertifiedGithubCommitStatusResult {
  state:'present'|'indeterminate';
  reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES'|'COLLECTION_ABSENCE_NOT_AUTHORITATIVE';
  repository_full_name:string;
  actual_state?:'error'|'failure'|'pending'|'success';
  evidence:CertifiedGithubStatusEvidence;
  legacy_interpretation:{
    mutation_certainty:'present'|'absent';
  };
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

export const GITHUB_COMMIT_STATUS_RESPONSE_SLICE=[
  {path:'[].id'},
  {path:'[].node_id'},
  {path:'[].state'},
  {path:'[].context'},
  {path:'[].target_url'},
  {path:'[].created_at'},
  {path:'[].updated_at'},
] as const satisfies readonly ResponseFieldSpec[];

export const GITHUB_COMMIT_STATUSES_OPERATION:GithubReadOperation={
  provider:'github',
  api_version:GITHUB_API_VERSION,
  method:'GET',
  path_template:'/repos/{owner}/{repo}/commits/{ref}/statuses',
  operation_id:'repos/list-commit-statuses-for-ref',
  parameters:[
    {name:'owner',in:'path',required:true,schema:{type:'string'}},
    {name:'ref',in:'path',required:true,schema:{type:'string'}},
    {name:'repo',in:'path',required:true,schema:{type:'string'}},
    {name:'page',in:'query',required:false,schema:{type:'integer'}},
    {name:'per_page',in:'query',required:false,schema:{type:'integer'}},
  ],
  outcomes:[{
    status:'200',
    description:'Response',
    schema:{
      type:'array',
      items:{
        type:'object',
        required:['id','node_id','state','context','target_url','created_at','updated_at'],
        properties:{
          id:{type:'integer'},
          node_id:{type:'string'},
          state:{type:'string'},
          context:{type:'string'},
          target_url:{type:'string',nullable:true},
          created_at:{type:'string'},
          updated_at:{type:'string'},
        },
      },
    },
  }],
  github_extensions:{},
};

function certifiedMembers(observation:ReturnType<typeof githubRawObservation>):{
  members:StatusMember[];
  validated_paths:string[];
  optional_absent_paths:string[];
} {
  const certified=validateObservationSlice(
    GITHUB_COMMIT_STATUSES_OPERATION,
    observation,
    GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
  );
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
    commitSha,
    context,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    commitSha:string;
    context:string;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubCommitStatusResult {
  const repository=observeCertifiedGithubRepositoryIdentity(token,{
    repositoryId,
    get,
    clock,
  });
  const fullName=repository.full_name;
  const {owner,repo}=repository;
  const target=githubStatusContextKey(context);
  const pages:CertifiedGithubStatusPageEvidence[]=[];

  for (let page=1;page<=1000;page+=1) {
    const body=get(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}/statuses?per_page=100&page=${page}`,
    );
    const observedAt=clock();
    const perPage=100;
    const raw=githubRawObservation({
      operation:GITHUB_COMMIT_STATUSES_OPERATION,
      observerId:'github-commit-status/v1',
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}/statuses?per_page=${perPage}&page=${page}`,
      parameters:{owner,repo,ref:commitSha,page,per_page:perPage},
      body,
      observedAt,
    });
    const certified=certifiedMembers(raw);
    pages.push({
      page,
      member_count:certified.members.length,
      observed_at:observedAt,
      validated_paths:certified.validated_paths,
      optional_absent_paths:certified.optional_absent_paths,
    });

    const match=certified.members.find(member=>githubStatusContextKey(member.context)===target);
    if (match) {
      return {
        state:'present',
        reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES',
        repository_full_name:fullName,
        actual_state:match.state,
        evidence:{
          provider:'github',
          api_version:GITHUB_API_VERSION,
          operation_id:'repos/list-commit-statuses-for-ref',
          schema_sha256:GITHUB_OPENAPI_SHA256,
          schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
          observer:{kind:'git-kernel',id:'github-commit-status/v1'},
          repository_id:repositoryId,
          repository_full_name:fullName,
          commit_sha:commitSha,
          repository_identity:repository.evidence,
          pages,
        },
        legacy_interpretation:{mutation_certainty:'present'},
      };
    }

    if (certified.members.length<100) {
      return {
        state:'indeterminate',
        reason:'COLLECTION_ABSENCE_NOT_AUTHORITATIVE',
        repository_full_name:fullName,
        evidence:{
          provider:'github',
          api_version:GITHUB_API_VERSION,
          operation_id:'repos/list-commit-statuses-for-ref',
          schema_sha256:GITHUB_OPENAPI_SHA256,
          schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
          observer:{kind:'git-kernel',id:'github-commit-status/v1'},
          repository_id:repositoryId,
          repository_full_name:fullName,
          commit_sha:commitSha,
          repository_identity:repository.evidence,
          pages,
        },
        legacy_interpretation:{mutation_certainty:'absent'},
      };
    }
  }

  throw new Error('GITHUB_STATUS_PAGINATION_EXHAUSTED');
}
