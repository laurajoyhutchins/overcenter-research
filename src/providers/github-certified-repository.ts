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
  type GithubJsonGet,
} from './github-rest.ts';

export const GITHUB_API_VERSION='2026-03-10';
export const GITHUB_OPENAPI_SOURCE_COMMIT='d4278c869e367f5d6d4e0f46878119128abba77b';
export const GITHUB_OPENAPI_SHA256='9d0534e66064a95f0637d542b463a868fc60a53a8cac37eddc85d72a465b8810';

export interface CertifiedGithubRepositoryEvidence {
  operation_id:'repos/get';
  observed_at:string;
  node_id:string;
  canonical_full_name:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubRepository {
  fact:RepositoryIdentityFact;
  evidence:CertifiedGithubRepositoryEvidence;
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

export function githubRepositoryCoordinate(fullName:string):{owner:string;repo:string} {
  const slash=fullName.indexOf('/');
  if (slash<=0 || slash===fullName.length-1 || fullName.indexOf('/',slash+1)!==-1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return {owner:fullName.slice(0,slash),repo:fullName.slice(slash+1)};
}

export function rawGithubObserved200({
  operation,
  path,
  parameters,
  body,
  observedAt,
  observerId,
}:{
  operation:ObservationOperation;
  path:string;
  parameters:Record<string,string|number|boolean>;
  body:unknown;
  observedAt:string;
  observerId:string;
}):RawObservation {
  return {
    contract:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      operation_id:operation.operation_id,
      schema_sha256:GITHUB_OPENAPI_SHA256,
    },
    observer:{kind:'git-kernel',id:observerId},
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

export function observeCertifiedGithubRepository(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    get=githubGet,
    clock=()=>new Date().toISOString(),
    observerId,
  }:{
    repositoryId:number;
    repositoryFullName:string;
    get?:GithubJsonGet;
    clock?:()=>string;
    observerId:string;
  },
):CertifiedGithubRepository {
  const {owner,repo}=githubRepositoryCoordinate(repositoryFullName);
  const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const body=get(token,path);
  const observedAt=clock();
  const raw=rawGithubObserved200({
    operation:GITHUB_REPOSITORY_OPERATION,
    path,
    parameters:{owner,repo},
    body,
    observedAt,
    observerId,
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
