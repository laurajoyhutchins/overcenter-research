import {
  validateObservationSlice,
  type ResponseFieldSpec,
} from '../provider-observation/response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import {
  observeCertifiedGithubRepositoryIdentity,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import {
  githubRawObservation,
  type GithubReadOperation,
} from './github-observation.ts';
import { githubGet, type GithubJsonGet } from './github-status.ts';

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
  repository_identity:CertifiedGithubRepositoryEvidence;
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

export const GITHUB_GET_REF_OPERATION:GithubReadOperation={
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

  const repository=observeCertifiedGithubRepositoryIdentity(token,{
    repositoryId,
    get,
    clock,
  });
  const fullName=repository.full_name;
  const {owner,repo}=repository;
  const requestRef=apiRef(canonicalRef);
  const body=get(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(requestRef)}`,
  );
  const observedAt=clock();
  const raw=githubRawObservation({
    operation:GITHUB_GET_REF_OPERATION,
    observerId:'github-ref-target/v1',
    path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(requestRef)}`,
    parameters:{owner,repo,ref:requestRef},
    body,
    observedAt,
  });
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
    repository_identity:repository.evidence,
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
