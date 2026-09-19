import { GITHUB_REPOSITORY_OPERATION } from './github-operations.generated.ts';
import { materializeGithubOperationRequest } from './github-openapi.ts';
import { observeCertifiedGithubRead200 } from './github-certified-observation.ts';
import { GITHUB_REPOSITORY_RESPONSE_SLICE } from './github-semantics.ts';
import { githubGet, type GithubJsonGet } from './github-rest.ts';

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

export function githubRepositoryCoordinate(fullName:string):{owner:string;repo:string} {
  const slash=fullName.indexOf('/');
  if (slash<=0 || slash===fullName.length-1 || fullName.indexOf('/',slash+1)!==-1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return {owner:fullName.slice(0,slash),repo:fullName.slice(slash+1)};
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
  const request=materializeGithubOperationRequest(GITHUB_REPOSITORY_OPERATION,{owner,repo});
  const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
    token,
    operation:GITHUB_REPOSITORY_OPERATION,
    request,
    fields:GITHUB_REPOSITORY_RESPONSE_SLICE,
    get,
    clock,
    observerId,
  });
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
export { GITHUB_REPOSITORY_OPERATION } from './github-operations.generated.ts';
export { GITHUB_REPOSITORY_RESPONSE_SLICE } from './github-semantics.ts';
export type { GithubObservationOperation } from './github-openapi.ts';
export type { GithubJsonGet } from './github-rest.ts';
