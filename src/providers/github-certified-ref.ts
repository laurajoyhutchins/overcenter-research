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

interface GithubRefOperation extends StructuralOperation {
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

interface GithubRefObservationRequest {
  method:'GET';
  path_template:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  headers:Record<string,string>;
  authorization:'bearer';
}

interface GithubRefObservationResponse {
  date:string|null;
  etag:string|null;
  link:string|null;
  request_id:string|null;
}

type GithubRefRawObservation=ProviderObservation<
  'github',
  GithubRefObservationRequest,
  GithubRefObservationResponse
>;

export interface CertifiedGithubRefEvidence {
  provider:'github';
  api_version:string;
  operation_id:'git/get-ref';
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-ref-target/v1'};
  repository_id:number;
  repository_full_name:string;
  ref:string;
  observed_at:string;
  validated_paths:string[];
  optional_absent_paths:string[];
  object_type:'commit'|'tag';
  actual_target_sha:string;
}

export interface CertifiedGithubRefResult {
  state:'present'|'absent';
  reason:'AUTHORITATIVE_BINDING_MATCHES'|'AUTHORITATIVE_BINDING_DIFFERS';
  repository_full_name:string;
  ref:string;
  actual_target_sha:string;
  evidence:CertifiedGithubRefEvidence;
}

export const GITHUB_REF_RESPONSE_SLICE=[
  {path:'ref'},
  {path:'object.type'},
  {path:'object.sha'},
] as const satisfies readonly ResponseFieldSpec[];

export const GITHUB_GET_REF_OPERATION:GithubRefOperation={
  provider:'github',
  api_version:GITHUB_API_VERSION,
  method:'GET',
  path_template:'/repos/{owner}/{repo}/git/ref/{ref}',
  operation_id:'git/get-ref',
  parameters:[
    {name:'owner',in:'path',required:true,schema:{type:'string'}},
    {name:'repo',in:'path',required:true,schema:{type:'string'}},
    {name:'ref',in:'path',required:true,schema:{type:'string'}},
  ],
  outcomes:[{
    status:'200',
    description:'Response',
    schema:{
      type:'object',
      required:['ref','object'],
      properties:{
        ref:{type:'string'},
        object:{
          type:'object',
          required:['type','sha'],
          properties:{
            type:{type:'string'},
            sha:{type:'string',minLength:40,maxLength:40},
          },
        },
      },
    },
  }],
  github_extensions:{},
};

const SHA=/^[0-9a-f]{40,64}$/i;

export function canonicalGithubRef(ref:string):string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
}

function apiRef(ref:string):string {
  return canonicalGithubRef(ref).slice('refs/'.length);
}

function repositoryCoordinate(fullName:string):{owner:string;repo:string} {
  const slash=fullName.indexOf('/');
  if (slash<=0 || slash===fullName.length-1 || fullName.indexOf('/',slash+1)!==-1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return {owner:fullName.slice(0,slash),repo:fullName.slice(slash+1)};
}

function rawRefObservation({
  body,
  owner,
  repo,
  ref,
  observedAt,
}:{
  body:unknown;
  owner:string;
  repo:string;
  ref:string;
  observedAt:string;
}):GithubRefRawObservation {
  const requestRef=apiRef(ref);
  return {
    contract:{
      provider:'github',
      api_version:GITHUB_API_VERSION,
      operation_id:GITHUB_GET_REF_OPERATION.operation_id,
      schema_sha256:GITHUB_OPENAPI_SHA256,
    },
    observer:{kind:'git-kernel',id:'github-ref-target/v1'},
    observed_at:observedAt,
    request:{
      method:'GET',
      path_template:GITHUB_GET_REF_OPERATION.path_template,
      path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(requestRef)}`,
      parameters:{owner,repo,ref:requestRef},
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

export function observeCertifiedGithubRefTarget(
  token:string,
  {
    repositoryId,
    ref,
    targetSha,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    ref:string;
    targetSha:string;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubRefResult {
  const canonicalRef=canonicalGithubRef(ref);
  if (!SHA.test(targetSha)) throw new Error('GITHUB_REF_TARGET_SHA_INVALID');

  const repository=get(token,`/repositories/${repositoryId}`) as {
    id?:unknown;
    full_name?:unknown;
  };
  if (repository.id!==repositoryId || typeof repository.full_name!=='string') {
    throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  }

  const fullName=repository.full_name;
  const {owner,repo}=repositoryCoordinate(fullName);
  const requestRef=apiRef(canonicalRef);
  const body=get(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(requestRef)}`,
  );
  const observedAt=clock();
  const raw=rawRefObservation({body,owner,repo,ref:canonicalRef,observedAt});
  const certified=validateObservationSlice(
    GITHUB_GET_REF_OPERATION,
    raw,
    GITHUB_REF_RESPONSE_SLICE,
  );

  const value=certified.outcome.value as {
    ref:string;
    object:{type:string;sha:string};
  };
  if (!['commit','tag'].includes(value.object.type)) {
    throw new Error('GITHUB_REF_OBJECT_TYPE_INVALID');
  }
  if (!SHA.test(value.object.sha)) {
    throw new Error('GITHUB_REF_OBJECT_SHA_INVALID');
  }
  if (canonicalGithubRef(value.ref)!==canonicalRef) {
    throw new Error('GITHUB_REF_RESPONSE_COORDINATE_MISMATCH');
  }

  const actualTargetSha=value.object.sha.toLowerCase();
  const matches=actualTargetSha===targetSha.toLowerCase();
  const evidence:CertifiedGithubRefEvidence={
    provider:'github',
    api_version:GITHUB_API_VERSION,
    operation_id:'git/get-ref',
    schema_sha256:GITHUB_OPENAPI_SHA256,
    schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
    observer:{kind:'git-kernel',id:'github-ref-target/v1'},
    repository_id:repositoryId,
    repository_full_name:fullName,
    ref:canonicalRef,
    observed_at:observedAt,
    validated_paths:certified.structural_validation.validated_paths,
    optional_absent_paths:certified.structural_validation.optional_absent_paths,
    object_type:value.object.type as 'commit'|'tag',
    actual_target_sha:actualTargetSha,
  };

  return {
    state:matches?'present':'absent',
    reason:matches?'AUTHORITATIVE_BINDING_MATCHES':'AUTHORITATIVE_BINDING_DIFFERS',
    repository_full_name:fullName,
    ref:canonicalRef,
    actual_target_sha:actualTargetSha,
    evidence,
  };
}
