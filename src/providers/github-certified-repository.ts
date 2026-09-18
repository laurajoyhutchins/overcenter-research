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
import { githubGet, type GithubJsonGet } from './github-status.ts';

interface GithubObservationParameter {
  name:string;
  in:'path';
  required:boolean;
  schema:unknown;
}

interface GithubRepositoryOperation extends StructuralOperation {
  provider:'github';
  api_version:string;
  method:'GET';
  path_template:string;
  parameters:GithubObservationParameter[];
  outcomes:Array<{
    status:string;
    description:string;
    schema:unknown;
  }>;
  github_extensions:Record<string,unknown>;
}

interface GithubRepositoryObservationRequest {
  method:'GET';
  path_template:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  headers:Record<string,string>;
  authorization:'bearer';
}

interface GithubRepositoryObservationResponse {
  date:string|null;
  etag:string|null;
  link:string|null;
  request_id:string|null;
}

type GithubRepositoryRawObservation=ProviderObservation<
  'github',
  GithubRepositoryObservationRequest,
  GithubRepositoryObservationResponse
>;

export interface GithubRepositoryBootstrapHint {
  endpoint:'/repositories/{repository_id}';
  repository_id:number;
  full_name:string;
  authoritative:false;
}

export interface CertifiedGithubRepositoryEvidence {
  provider:'github';
  api_version:string;
  operation_id:'repos/get';
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-repository-identity/v1'};
  repository_id:number;
  repository_node_id:string;
  repository_full_name:string;
  owner:string;
  repo:string;
  observed_at:string;
  validated_paths:string[];
  optional_absent_paths:string[];
  bootstrap_hint:GithubRepositoryBootstrapHint;
}

export interface CertifiedGithubRepositoryIdentity {
  repository_id:number;
  node_id:string;
  owner:string;
  repo:string;
  full_name:string;
  evidence:CertifiedGithubRepositoryEvidence;
}

export const GITHUB_REPOSITORY_RESPONSE_SLICE=[
  {path:'id'},
  {path:'node_id'},
  {path:'full_name'},
  {path:'name'},
  {path:'owner.login'},
] as const satisfies readonly ResponseFieldSpec[];

export const GITHUB_GET_REPOSITORY_OPERATION:GithubRepositoryOperation={
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

function parseFullName(fullName:string):{owner:string;repo:string} {
  const slash=fullName.indexOf('/');
  if (slash<=0 || slash===fullName.length-1 || fullName.indexOf('/',slash+1)!==-1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return {owner:fullName.slice(0,slash),repo:fullName.slice(slash+1)};
}

function rawRepositoryObservation({
  body,
  owner,
  repo,
  observedAt,
}:{
  body:unknown;
  owner:string;
  repo:string;
  observedAt:string;
}):GithubRepositoryRawObservation {
  return {
    contract:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      operation_id:GITHUB_GET_REPOSITORY_OPERATION.operation_id,
      schema_sha256:GITHUB_OPENAPI_SHA256,
    },
    observer:{kind:'git-kernel',id:'github-repository-identity/v1'},
    observed_at:observedAt,
    request:{
      method:'GET',
      path_template:GITHUB_GET_REPOSITORY_OPERATION.path_template,
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      parameters:{owner,repo},
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

export function observeCertifiedGithubRepositoryIdentity(
  token:string,
  {
    repositoryId,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubRepositoryIdentity {
  if (!Number.isSafeInteger(repositoryId) || repositoryId<=0) {
    throw new Error('GITHUB_REPOSITORY_ID_INVALID');
  }

  // GitHub's numeric-ID route is intentionally used only as an alias hint.
  // It is not in the official OpenAPI description and therefore never becomes
  // authoritative evidence by itself.
  const hint=get(token,`/repositories/${repositoryId}`) as {
    id?:unknown;
    full_name?:unknown;
  };
  if (hint.id!==repositoryId || typeof hint.full_name!=='string') {
    throw new Error('GITHUB_REPOSITORY_BOOTSTRAP_HINT_INVALID');
  }
  const {owner,repo}=parseFullName(hint.full_name);

  const body=get(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  const observedAt=clock();
  const raw=rawRepositoryObservation({body,owner,repo,observedAt});
  const certified=validateObservationSlice(
    GITHUB_GET_REPOSITORY_OPERATION,
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
  if (value.id!==repositoryId) {
    throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  }
  if (value.node_id.length===0) {
    throw new Error('GITHUB_REPOSITORY_NODE_ID_INVALID');
  }
  if (value.owner.login.toLowerCase()!==owner.toLowerCase()
    || value.name.toLowerCase()!==repo.toLowerCase()
    || value.full_name.toLowerCase()!==`${value.owner.login}/${value.name}`.toLowerCase()) {
    throw new Error('GITHUB_REPOSITORY_ALIAS_MISMATCH');
  }

  const bootstrapHint:GithubRepositoryBootstrapHint={
    endpoint:'/repositories/{repository_id}',
    repository_id:repositoryId,
    full_name:hint.full_name,
    authoritative:false,
  };

  return {
    repository_id:repositoryId,
    node_id:value.node_id,
    owner:value.owner.login,
    repo:value.name,
    full_name:value.full_name,
    evidence:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      operation_id:'repos/get',
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-repository-identity/v1'},
      repository_id:repositoryId,
      repository_node_id:value.node_id,
      repository_full_name:value.full_name,
      owner:value.owner.login,
      repo:value.name,
      observed_at:observedAt,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
      bootstrap_hint:bootstrapHint,
    },
  };
}
