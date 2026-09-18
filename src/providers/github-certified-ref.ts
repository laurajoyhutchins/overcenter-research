import type { ObservationOperation } from '../../experiments/github-observation-grammar/openapi.ts';
import {
  RESPONSE_SLICES,
  validateObservationSlice,
} from '../../experiments/github-observation-grammar/response-slice.ts';
import {
  projectGitRefTarget,
} from '../../experiments/github-observation-grammar/semantics.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
  observeCertifiedGithubRepository,
  rawGithubObserved200,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import {
  githubGet,
  type GithubJsonGet,
} from './github-rest.ts';

const SHA=/^[0-9a-f]{40,64}$/i;

export const GITHUB_REF_OPERATION:ObservationOperation={
  provider:'github',
  api_version:GITHUB_API_VERSION,
  method:'GET',
  path_template:'/repos/{owner}/{repo}/git/ref/{ref}',
  operation_id:'git/get-ref',
  parameters:[
    {name:'owner',in:'path',required:true,schema:{type:'string'}},
    {name:'ref',in:'path',required:true,schema:{type:'string'}},
    {name:'repo',in:'path',required:true,schema:{type:'string'}},
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
            sha:{type:'string'},
          },
        },
      },
    },
  }],
  github_extensions:{},
};

export interface CertifiedGithubRefEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-ref-fence/v1'};
  repository_id:number;
  requested_repository_full_name:string;
  repository:CertifiedGithubRepositoryEvidence;
  operation_id:'git/get-ref';
  observed_at:string;
  requested_ref:string;
  canonical_ref:string;
  object_kind:'github.commit'|'github.tag';
  actual_sha:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubRefFenceResult {
  state:'CURRENT'|'STALE'|'INDETERMINATE';
  reason:
    | 'AUTHORITATIVE_BINDING_MATCHES'
    | 'AUTHORITATIVE_BINDING_DIFFERS'
    | 'OBSERVATION_FAILED';
  repository_full_name?:string;
  ref:string;
  expected_sha:string;
  actual_sha?:string;
  evidence?:CertifiedGithubRefEvidence;
  observation_error?:string;
}

function apiRef(ref:string):string {
  const value=ref.startsWith('refs/')?ref.slice('refs/'.length):ref;
  if (value.length===0) throw new Error('GITHUB_REF_INVALID');
  return value;
}

export function observeCertifiedGithubRefFence(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    ref,
    expectedSha,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    repositoryFullName:string;
    ref:string;
    expectedSha:string;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubRefFenceResult {
  if (!SHA.test(expectedSha)) throw new Error('GITHUB_REF_EXPECTED_SHA_INVALID');
  const requestedRef=apiRef(ref);

  try {
    const repository=observeCertifiedGithubRepository(token,{
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId:'github-ref-fence/v1',
    });
    const {owner,repo}=repository.fact.object;
    const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(requestedRef)}`;
    const body=get(token,path);
    const observedAt=clock();
    const raw=rawGithubObserved200({
      operation:GITHUB_REF_OPERATION,
      path,
      parameters:{owner,repo,ref:requestedRef},
      body,
      observedAt,
      observerId:'github-ref-fence/v1',
    });
    const certified=validateObservationSlice(
      GITHUB_REF_OPERATION,
      raw,
      RESPONSE_SLICES['git/get-ref'],
    );
    const fact=projectGitRefTarget(certified,repository.fact);
    if (!fact) {
      return {
        state:'INDETERMINATE',
        reason:'OBSERVATION_FAILED',
        repository_full_name:repository.fact.object.full_name,
        ref:requestedRef,
        expected_sha:expectedSha,
        observation_error:'GITHUB_REF_OBSERVATION_DOES_NOT_PROVE_BINDING',
      };
    }

    const evidence:CertifiedGithubRefEvidence={
      provider:'github',
      api_version:GITHUB_API_VERSION,
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-ref-fence/v1'},
      repository_id:repositoryId,
      requested_repository_full_name:repositoryFullName,
      repository:repository.evidence,
      operation_id:'git/get-ref',
      observed_at:observedAt,
      requested_ref:requestedRef,
      canonical_ref:fact.subject.ref,
      object_kind:fact.object.kind,
      actual_sha:fact.object.sha,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    };

    const current=fact.object.sha.toLowerCase()===expectedSha.toLowerCase();
    return {
      state:current?'CURRENT':'STALE',
      reason:current?'AUTHORITATIVE_BINDING_MATCHES':'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name:repository.fact.object.full_name,
      ref:fact.subject.ref,
      expected_sha:expectedSha,
      actual_sha:fact.object.sha,
      evidence,
    };
  } catch (error:unknown) {
    return {
      state:'INDETERMINATE',
      reason:'OBSERVATION_FAILED',
      ref:requestedRef,
      expected_sha:expectedSha,
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}
