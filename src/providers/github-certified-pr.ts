import type { ObservationOperation } from '../../experiments/github-observation-grammar/openapi.ts';
import {
  RESPONSE_SLICES,
  validateObservationSlice,
} from '../../experiments/github-observation-grammar/response-slice.ts';
import {
  projectPullRequestSnapshot,
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

export const GITHUB_PULL_REQUEST_OPERATION:ObservationOperation={
  provider:'github',
  api_version:GITHUB_API_VERSION,
  method:'GET',
  path_template:'/repos/{owner}/{repo}/pulls/{pull_number}',
  operation_id:'pulls/get',
  parameters:[
    {name:'owner',in:'path',required:true,schema:{type:'string'}},
    {name:'pull_number',in:'path',required:true,schema:{type:'integer'}},
    {name:'repo',in:'path',required:true,schema:{type:'string'}},
  ],
  outcomes:[{
    status:'200',
    description:'Response',
    schema:{
      type:'object',
      required:['id','node_id','number','state','head','base'],
      properties:{
        id:{type:'integer'},
        node_id:{type:'string'},
        number:{type:'integer'},
        state:{type:'string',enum:['open','closed']},
        head:{
          type:'object',
          required:['sha'],
          properties:{sha:{type:'string'}},
        },
        base:{
          type:'object',
          required:['ref','sha'],
          properties:{
            ref:{type:'string'},
            sha:{type:'string'},
          },
        },
      },
    },
  }],
  github_extensions:{},
};

export interface GithubPullRequestExpectedIdentity {
  node_id:string;
  state:string;
  head_sha:string;
  base_ref:string;
  base_sha:string;
}

export interface CertifiedGithubPullRequestEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-pr-identity/v1'};
  repository_id:number;
  requested_repository_full_name:string;
  repository:CertifiedGithubRepositoryEvidence;
  operation_id:'pulls/get';
  observed_at:string;
  pull_number:number;
  pull_id:number;
  node_id:string;
  state:string;
  head_sha:string;
  base_ref:string;
  base_sha:string;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export interface CertifiedGithubPullRequestIdentityResult {
  state:'CURRENT'|'STALE'|'INDETERMINATE';
  reason:
    | 'AUTHORITATIVE_PR_IDENTITY_MATCHES'
    | 'AUTHORITATIVE_PR_IDENTITY_DIFFERS'
    | 'OBSERVATION_FAILED';
  repository_full_name?:string;
  pull_number:number;
  expected:GithubPullRequestExpectedIdentity;
  actual?:GithubPullRequestExpectedIdentity & {id:number};
  differences?:string[];
  evidence?:CertifiedGithubPullRequestEvidence;
  observation_error?:string;
}

function validateExpected(expected:GithubPullRequestExpectedIdentity):void {
  if (!expected.node_id) throw new Error('GITHUB_PR_NODE_ID_REQUIRED');
  if (!expected.state) throw new Error('GITHUB_PR_STATE_REQUIRED');
  if (!SHA.test(expected.head_sha)) throw new Error('GITHUB_PR_HEAD_SHA_INVALID');
  if (!expected.base_ref) throw new Error('GITHUB_PR_BASE_REF_REQUIRED');
  if (!SHA.test(expected.base_sha)) throw new Error('GITHUB_PR_BASE_SHA_INVALID');
}

export function observeCertifiedGithubPullRequestIdentity(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    pullNumber,
    expected,
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    repositoryFullName:string;
    pullNumber:number;
    expected:GithubPullRequestExpectedIdentity;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubPullRequestIdentityResult {
  if (!Number.isSafeInteger(pullNumber) || pullNumber<=0) {
    throw new Error('GITHUB_PR_NUMBER_INVALID');
  }
  validateExpected(expected);

  try {
    const repository=observeCertifiedGithubRepository(token,{
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId:'github-pr-identity/v1',
    });
    const {owner,repo}=repository.fact.object;
    const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
    const body=get(token,path);
    const observedAt=clock();
    const raw=rawGithubObserved200({
      operation:GITHUB_PULL_REQUEST_OPERATION,
      path,
      parameters:{owner,repo,pull_number:pullNumber},
      body,
      observedAt,
      observerId:'github-pr-identity/v1',
    });
    const certified=validateObservationSlice(
      GITHUB_PULL_REQUEST_OPERATION,
      raw,
      RESPONSE_SLICES['pulls/get'],
    );
    const fact=projectPullRequestSnapshot(certified,repository.fact);
    if (!fact) {
      return {
        state:'INDETERMINATE',
        reason:'OBSERVATION_FAILED',
        repository_full_name:repository.fact.object.full_name,
        pull_number:pullNumber,
        expected,
        observation_error:'GITHUB_PR_OBSERVATION_DOES_NOT_PROVE_SNAPSHOT',
      };
    }

    const actual={
      id:fact.subject.id,
      node_id:fact.subject.node_id,
      state:fact.state,
      head_sha:fact.head_sha,
      base_ref:fact.base_ref,
      base_sha:fact.base_sha,
    };
    const differences:string[]=[];
    if (actual.node_id!==expected.node_id) differences.push('node_id');
    if (actual.state!==expected.state) differences.push('state');
    if (actual.head_sha.toLowerCase()!==expected.head_sha.toLowerCase()) differences.push('head_sha');
    if (actual.base_ref!==expected.base_ref) differences.push('base_ref');
    if (actual.base_sha.toLowerCase()!==expected.base_sha.toLowerCase()) differences.push('base_sha');

    const evidence:CertifiedGithubPullRequestEvidence={
      provider:'github',
      api_version:GITHUB_API_VERSION,
      schema_sha256:GITHUB_OPENAPI_SHA256,
      schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      observer:{kind:'git-kernel',id:'github-pr-identity/v1'},
      repository_id:repositoryId,
      requested_repository_full_name:repositoryFullName,
      repository:repository.evidence,
      operation_id:'pulls/get',
      observed_at:observedAt,
      pull_number:pullNumber,
      pull_id:fact.subject.id,
      node_id:fact.subject.node_id,
      state:fact.state,
      head_sha:fact.head_sha,
      base_ref:fact.base_ref,
      base_sha:fact.base_sha,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    };

    return {
      state:differences.length===0?'CURRENT':'STALE',
      reason:differences.length===0
        ?'AUTHORITATIVE_PR_IDENTITY_MATCHES'
        :'AUTHORITATIVE_PR_IDENTITY_DIFFERS',
      repository_full_name:repository.fact.object.full_name,
      pull_number:pullNumber,
      expected,
      actual,
      differences,
      evidence,
    };
  } catch (error:unknown) {
    return {
      state:'INDETERMINATE',
      reason:'OBSERVATION_FAILED',
      pull_number:pullNumber,
      expected,
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}
