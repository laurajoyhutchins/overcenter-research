import type { ProviderObservation } from '../provider-observation/observation.ts';
import type { StructuralOperation } from '../provider-observation/response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
} from './github-contract.ts';

export interface GithubObservationParameter {
  name:string;
  in:'path'|'query';
  required:boolean;
  schema:unknown;
}

export interface GithubReadOperation extends StructuralOperation {
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

export interface GithubObservationRequest {
  method:'GET';
  path_template:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  headers:Record<string,string>;
  authorization:'bearer';
}

export interface GithubObservationResponse {
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

export function githubRawObservation({
  operation,
  observerId,
  path,
  parameters,
  body,
  observedAt,
}:{
  operation:GithubReadOperation;
  observerId:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  body:unknown;
  observedAt:string;
}):GithubRawObservation {
  if (operation.provider!=='github'
    || operation.api_version!==GITHUB_API_VERSION
    || operation.method!=='GET') {
    throw new Error('GITHUB_OBSERVATION_OPERATION_CONTRACT_INVALID');
  }
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
