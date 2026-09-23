import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './contract.ts';
import { GITHUB_REF_OPERATION } from './operations.generated.ts';
import { materializeGithubOperationRequest } from './openapi.ts';
import { GITHUB_REF_RESPONSE_SLICE } from './semantics.ts';
import {
  observeCertifiedGithubRepository,
  type CertifiedGithubRepositoryEvidence,
} from './certified-repository.ts';
import { observeCertifiedGithubRead200 } from './certified-observation.ts';
import {
  githubGet,
  isGithubObjectId,
  sameGithubObjectId,
  type GithubJsonGet,
} from './rest.ts';

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
  reason:'AUTHORITATIVE_BINDING_MATCHES'|'AUTHORITATIVE_BINDING_DIFFERS'|'OBSERVATION_FAILED';
  repository_full_name?:string;
  ref:string;
  expected_sha:string;
  actual_sha?:string;
  evidence?:CertifiedGithubRefEvidence;
  observation_error?:string;
}

export function canonicalGithubRef(ref:string):string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
}

function apiRef(ref:string):string {
  return canonicalGithubRef(ref).slice('refs/'.length);
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
  if (!isGithubObjectId(expectedSha)) throw new Error('GITHUB_REF_EXPECTED_SHA_INVALID');
  const canonicalRef=canonicalGithubRef(ref);
  const requestedRef=apiRef(canonicalRef);

  try {
    const repository=observeCertifiedGithubRepository(token,{
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId:'github-ref-fence/v1',
    });
    const {owner,repo}=repository.fact.object;
    const request=materializeGithubOperationRequest(GITHUB_REF_OPERATION,{
      owner,
      repo,
      ref:requestedRef,
    });
    const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
      token,
      operation:GITHUB_REF_OPERATION,
      request,
      fields:GITHUB_REF_RESPONSE_SLICE,
      get,
      clock,
      observerId:'github-ref-fence/v1',
    });
    const value=certified.outcome.value as {
      ref:string;
      object:{type:string;sha:string};
    };
    if (!['commit','tag'].includes(value.object.type)) {
      throw new Error('GITHUB_REF_OBJECT_TYPE_INVALID');
    }
    if (!isGithubObjectId(value.object.sha)) throw new Error('GITHUB_REF_OBJECT_SHA_INVALID');
    if (canonicalGithubRef(value.ref)!==canonicalRef) {
      throw new Error('GITHUB_REF_RESPONSE_COORDINATE_MISMATCH');
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
      canonical_ref:canonicalRef,
      object_kind:value.object.type==='commit'?'github.commit':'github.tag',
      actual_sha:value.object.sha,
      validated_paths:certified.structural_validation.validated_paths,
      optional_absent_paths:certified.structural_validation.optional_absent_paths,
    };

    const current=sameGithubObjectId(value.object.sha,expectedSha);
    return {
      state:current?'CURRENT':'STALE',
      reason:current?'AUTHORITATIVE_BINDING_MATCHES':'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name:repository.fact.object.full_name,
      ref:canonicalRef,
      expected_sha:expectedSha,
      actual_sha:value.object.sha,
      evidence,
    };
  } catch (error:unknown) {
    return {
      state:'INDETERMINATE',
      reason:'OBSERVATION_FAILED',
      ref:canonicalRef,
      expected_sha:expectedSha,
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}

export { GITHUB_REF_OPERATION } from './operations.generated.ts';
export { GITHUB_REF_RESPONSE_SLICE } from './semantics.ts';
