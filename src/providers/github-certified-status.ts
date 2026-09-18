import type {
  ObservationOperation,
  RawObservation,
} from '../../experiments/github-observation-grammar/openapi.ts';
import {
  RESPONSE_SLICES,
  validateObservationSlice,
} from '../../experiments/github-observation-grammar/response-slice.ts';
import {
  projectRepositoryIdentity,
  type RepositoryIdentityFact,
} from '../../experiments/github-observation-grammar/semantics.ts';
import {
  githubGet,
  githubStatusContextKey,
} from './github-rest.ts';

export const GITHUB_API_VERSION='2026-03-10';
export const GITHUB_OPENAPI_SOURCE_COMMIT='d4278c869e367f5d6d4e0f46878119128abba77b';
export const GITHUB_OPENAPI_SHA256='9d0534e66064a95f0637d542b463a868fc60a53a8cac37eddc85d72a465b8810';

export type GithubJsonGet=(token:string,path:string)=>unknown;

export interface CertifiedGithubRepositoryEvidence {
  operation_id:'repos/get';
  observed_at:string;
  node_id:string;
  canonical_full_name:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

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
  reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES'|'COLLECTION_ABSENCE_NOT_AUTHORITATIVE';
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

export const GITHUB_REPOSITORY_OPERATION:ObservationOperation={
  provider:'github',
  api_version:GITHUB_API_VERSION,
  method:'GET',
  path_template:'/repos/{owner}/{repo}',
  operation_id:'repos/get',
  parameters:[
    {name:'owner',in:'path',required:true,schema:{type:'string'}},
    {name:'repo',in:'path',required:true,schema:{type:'string'}},
  ],
  outcomes:[{
    status:'200',
    description:'Response',
    schema:{
      type:'object',
      required:['id','node_id','full_name','name','owner'],
      properties:{
        id:{type:'integer'},
        node_id:{type:'string'},
        full_name:{type:'string'},
        name:{type:'string'},
        owner:{
          type:'object',
          required:['login'],
          properties:{
            login:{type:'string'},
          },
        },
      },
    },
  }],
  github_extensions:{},
};

export const GITHUB_COMMIT_STATUSES_OPERATION:ObservationOperation={
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

function repositoryCoordinate(fullName:string):{owner:string;repo:string} {
  const slash=fullName.indexOf('/');
  if (slash<=0 || slash===fullName.length-1 || fullName.indexOf('/',slash+1)!==-1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return {owner:fullName.slice(0,slash),repo:fullName.slice(slash+1)};
}

function rawObserved200({
  operation,
  path,
  parameters,
  body,
  observedAt,
}:{
  operation:ObservationOperation;
  path:string;
  parameters:Record<string,string|number|boolean>;
  body:unknown;
  observedAt:string;
}):RawObservation {
  return {
    contract:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      operation_id:operation.operation_id,
      schema_sha256:GITHUB_OPENAPI_SHA256,
    },
    observer:{kind:'git-kernel',id:'github-commit-status/v2'},
    observed_at:observedAt,
    request:{
      method:'GET',
      path_template:operation.path_template,
      path,
      parameters,
      headers:{
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':GITHUB_API_VERSION,
      },
      authorization:'bearer',
    },
    response:{date:null,etag:null,link:null,request_id:null},
    outcome:{status:200,visibility:'observed',value:body},
  };
}

function certifyRepository({
  body,
  repositoryId,
  repositoryFullName,
  observedAt,
}:{
  body:unknown;
  repositoryId:number;
  repositoryFullName:string;
  observedAt:string;
}):{
  fact:RepositoryIdentityFact;
  evidence:CertifiedGithubRepositoryEvidence;
} {
  const {owner,repo}=repositoryCoordinate(repositoryFullName);
  const raw=rawObserved200({
    operation:GITHUB_REPOSITORY_OPERATION,
    path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    parameters:{owner,repo},
    body,
    observedAt,
  });
  const certified=validateObservationSlice(
    GITHUB_REPOSITORY_OPERATION,
    raw,
    RESPONSE_SLICES['repos/get'],
  );
  const fact=projectRepositoryIdentity(certified);
  if (!fact) throw new Error('GITHUB_REPOSITORY_OBSERVATION_INVALID');
  if (fact.subject.id!==repositoryId) throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  if (fact.subject.node_id.length===0) throw new Error('GITHUB_REPOSITORY_NODE_ID_INVALID');
  return {
    fact,
    evidence:{
      operation_id:'repos/get',
      observed_at:observedAt,
      node_id:fact.subject.node_id,
      canonical_full_name:fact.object.full_name,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    },
  };
}

function certifiedMembers(observation:RawObservation):{
  members:StatusMember[];
  validated_paths:string[];
  optional_absent_paths:string[];
} {
  const certified=validateObservationSlice(
    GITHUB_COMMIT_STATUSES_OPERATION,
    observation,
    RESPONSE_SLICES['repos/list-commit-statuses-for-ref'],
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
  const requested=repositoryCoordinate(repositoryFullName);
  const repositoryBody=get(
    token,
    `/repos/${encodeURIComponent(requested.owner)}/${encodeURIComponent(requested.repo)}`,
  );
  const repositoryObservedAt=clock();
  const repository=certifyRepository({
    body:repositoryBody,
    repositoryId,
    repositoryFullName,
    observedAt:repositoryObservedAt,
  });

  const {owner,repo}=repository.fact.object;
  const canonicalFullName=repository.fact.object.full_name;
  const target=githubStatusContextKey(context);
  const pages:CertifiedGithubStatusPageEvidence[]=[];

  for (let page=1;page<=1000;page+=1) {
    const perPage=100;
    const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}/statuses?per_page=${perPage}&page=${page}`;
    const body=get(token,path);
    const observedAt=clock();
    const raw=rawObserved200({
      operation:GITHUB_COMMIT_STATUSES_OPERATION,
      path,
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

    const match=certified.members.find(
      member=>githubStatusContextKey(member.context)===target,
    );
    if (match) {
      return {
        state:'present',
        reason:'AUTHORITATIVE_COLLECTION_MEMBER_MATCHES',
        repository_full_name:canonicalFullName,
        actual_state:match.state,
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

    if (certified.members.length<perPage) {
      return {
        state:'indeterminate',
        reason:'COLLECTION_ABSENCE_NOT_AUTHORITATIVE',
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
  }

  throw new Error('GITHUB_STATUS_PAGINATION_EXHAUSTED');
}
