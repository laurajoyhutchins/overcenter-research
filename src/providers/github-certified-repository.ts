import type { ProviderObservation } from '../provider-observation/observation.ts';
import {
  validateObservationSlice,
  type ResponseFieldSpec,
  type StructuralOperation,
} from '../provider-observation/response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import { githubGet, type GithubJsonGet } from './github-rest.ts';

interface GithubObservationParameter {
  name:string;
  in:'path'|'query';
  required:boolean;
  schema:unknown;
}

export interface GithubObservationOperation extends StructuralOperation {
  provider:'github';
  api_version:string;
  method:'GET';
  path_template:string;
  parameters:GithubObservationParameter[];
  outcomes:Array<{status:string;description:string;schema:unknown}>;
  github_extensions:Record<string,unknown>;
}

interface GithubObservationRequest {
  method:'GET';
  path_template:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  headers:Record<string,string>;
  authorization:'bearer';
}

interface GithubObservationResponse {
  date:string|null;
  etag:string|null;
  link:string|null;
  request_id:string|null;
}

export type GithubRawObservation=ProviderObservation<
  'github',
  GithubObservationRequest,
  GithubObservationResponse
>;

export interface RepositoryIdentityFact {
  kind:'repository-identity';
  subject:{kind:'github.repository';id:number;node_id:string};
  relation:'named';
  object:{owner:string;repo:string;full_name:string};
  stability:'stable-subject-mutable-alias';
}

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

export const GITHUB_REPOSITORY_RESPONSE_SLICE=[
  {path:'id'},
  {path:'node_id'},
  {path:'full_name'},
  {path:'name'},
  {path:'owner.login'},
] as const satisfies readonly ResponseFieldSpec[];

export const GITHUB_REPOSITORY_OPERATION:GithubObservationOperation={
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
          properties:{login:{type:'string'}},
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
  operation:GithubObservationOperation;
  path:string;
  parameters:Record<string,string|number|boolean>;
  body:unknown;
  observedAt:string;
  observerId:string;
}):GithubRawObservation {
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
    GITHUB_REPOSITORY_RESPONSE_SLICE,
  );
  const value=certified.outcome.value as {
    id:number;
    node_id:string;
    full_name:string;
    name:string;
    owner:{login:string};
  };
  if (value.id<=0 || value.node_id.length===0) {
    throw new Error('GITHUB_REPOSITORY_OBSERVATION_INVALID');
  }
  if (
    value.owner.login.toLowerCase()!==owner.toLowerCase()
    || value.name.toLowerCase()!==repo.toLowerCase()
    || value.full_name.toLowerCase()!==`${value.owner.login}/${value.name}`.toLowerCase()
  ) {
    throw new Error('GITHUB_REPOSITORY_COORDINATE_MISMATCH');
  }
  if (value.id!==repositoryId) throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');

  const fact:RepositoryIdentityFact={
    kind:'repository-identity',
    subject:{kind:'github.repository',id:value.id,node_id:value.node_id},
    relation:'named',
    object:{owner:value.owner.login,repo:value.name,full_name:value.full_name},
    stability:'stable-subject-mutable-alias',
  };

  return {
    fact,
    evidence:{
      operation_id:'repos/get',
      observed_at:observedAt,
      node_id:value.node_id,
      canonical_full_name:value.full_name,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    },
  };
}

export {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
export type { GithubJsonGet } from './github-rest.ts';
