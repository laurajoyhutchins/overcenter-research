import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';
import { GITHUB_OBSERVATION_OPERATIONS } from './github-operations.generated.ts';
import { materializeGithubOperationRequest } from './github-openapi.ts';
import {
  GITHUB_OPERATION_SEMANTICS,
  type GithubSemanticOperationName,
} from './github-semantics.ts';
import {
  githubRepositoryCoordinate,
  observeCertifiedGithubRepository,
  type CertifiedGithubRepositoryEvidence,
} from './github-certified-repository.ts';
import { observeCertifiedGithubRead200 } from './github-certified-observation.ts';
import { githubGet,type GithubJsonGet } from './github-rest.ts';

export type GithubGenericSemanticOperationName=Exclude<GithubSemanticOperationName,'repository'>;

export interface CertifiedGithubSemanticReadEvidence {
  provider:'github';
  api_version:string;
  schema_sha256:string;
  schema_source_commit:string;
  observer:{kind:'git-kernel';id:'github-semantic-read/v1'};
  repository_id:number;
  requested_repository_full_name:string;
  repository:CertifiedGithubRepositoryEvidence;
  operation_key:GithubGenericSemanticOperationName;
  operation_id:string;
  observed_at:string;
  request_path:string;
  parameters:Record<string,string|number|boolean>;
  paginated:boolean;
  negative_evidence_authoritative:false;
  validated_paths:string[];
  optional_absent_paths:string[];
}

export type CertifiedGithubSemanticReadResult=
  | {state:'observed';value:unknown;evidence:CertifiedGithubSemanticReadEvidence}
  | {
      state:'indeterminate';
      operation_key:GithubGenericSemanticOperationName;
      operation_id:string;
      observation_error:string;
    };

function validateParameters(
  operationName:GithubGenericSemanticOperationName,
  parameters:Record<string,string|number|boolean>,
):void {
  const operation=GITHUB_OBSERVATION_OPERATIONS[operationName];
  const allowed=new Set(operation.parameters.map(parameter=>parameter.name));
  for (const reserved of ['owner','repo']) {
    if (Object.hasOwn(parameters,reserved)) {
      throw new Error(`GITHUB_SEMANTIC_READ_PARAMETER_RESERVED:${reserved}`);
    }
  }
  for (const name of Object.keys(parameters)) {
    if (!allowed.has(name)) throw new Error(`GITHUB_OPERATION_PARAMETER_UNKNOWN:${name}`);
  }
  for (const parameter of operation.parameters) {
    if (
      parameter.required
      && parameter.name!=='owner'
      && parameter.name!=='repo'
      && parameters[parameter.name]===undefined
    ) {
      throw new Error(`GITHUB_OPERATION_PARAMETER_REQUIRED:${parameter.name}`);
    }
  }
}

export function observeCertifiedGithubSemanticRead(
  token:string,
  {
    repositoryId,
    repositoryFullName,
    operation:operationName,
    parameters={},
    get=githubGet,
    clock=()=>new Date().toISOString(),
  }:{
    repositoryId:number;
    repositoryFullName:string;
    operation:GithubGenericSemanticOperationName;
    parameters?:Record<string,string|number|boolean>;
    get?:GithubJsonGet;
    clock?:()=>string;
  },
):CertifiedGithubSemanticReadResult {
  validateParameters(operationName,parameters);
  githubRepositoryCoordinate(repositoryFullName);
  const operation=GITHUB_OBSERVATION_OPERATIONS[operationName];
  const semantic=GITHUB_OPERATION_SEMANTICS[operationName];

  try {
    const repository=observeCertifiedGithubRepository(token,{
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId:'github-semantic-read/v1',
    });
    const {owner,repo}=repository.fact.object;
    const request=materializeGithubOperationRequest(operation,{owner,repo,...parameters});
    const {observed_at:observedAt,certified}=observeCertifiedGithubRead200({
      token,
      operation,
      request,
      fields:semantic.response_slice,
      get,
      clock,
      observerId:'github-semantic-read/v1',
    });

    return {
      state:'observed',
      value:certified.outcome.value,
      evidence:{
        provider:'github',
        api_version:GITHUB_API_VERSION,
        schema_sha256:GITHUB_OPENAPI_SHA256,
        schema_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
        observer:{kind:'git-kernel',id:'github-semantic-read/v1'},
        repository_id:repositoryId,
        requested_repository_full_name:repositoryFullName,
        repository:repository.evidence,
        operation_key:operationName,
        operation_id:operation.operation_id,
        observed_at:observedAt,
        request_path:request.path,
        parameters:request.parameters,
        paginated:operation.pagination!==undefined,
        negative_evidence_authoritative:false,
        validated_paths:certified.structural_validation.validated_paths,
        optional_absent_paths:certified.structural_validation.optional_absent_paths,
      },
    };
  } catch (error:unknown) {
    return {
      state:'indeterminate',
      operation_key:operationName,
      operation_id:operation.operation_id,
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}
