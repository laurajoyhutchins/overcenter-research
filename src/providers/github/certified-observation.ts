import type { ProviderObservation } from '../../observation/provider.ts';
import {
  validateObservationSlice,
  type CertifiedObservation,
  type ResponseFieldSpec,
} from '../../observation/response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
} from './contract.ts';
import type {
  GithubObservationOperation,
  MaterializedGithubOperationRequest,
} from './openapi.ts';
import type { GithubJsonGet } from './rest.ts';

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

type GithubRawObservation=ProviderObservation<
  'github',
  GithubObservationRequest,
  GithubObservationResponse
>;

function rawGithubObserved200({
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
  if (operation.method!=='GET') throw new Error('GITHUB_CERTIFIED_READ_REQUIRES_GET');
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

export function observeCertifiedGithubRead200({
  token,
  operation,
  request,
  fields,
  get,
  clock,
  observerId,
}:{
  token:string;
  operation:GithubObservationOperation;
  request:MaterializedGithubOperationRequest;
  fields:readonly ResponseFieldSpec[];
  get:GithubJsonGet;
  clock:()=>string;
  observerId:string;
}):{
  observed_at:string;
  certified:CertifiedObservation<GithubRawObservation>;
} {
  const body=get(token,request.path);
  const observedAt=clock();
  const raw=rawGithubObserved200({
    operation,
    path:request.path,
    parameters:request.parameters,
    body,
    observedAt,
    observerId,
  });
  return {
    observed_at:observedAt,
    certified:validateObservationSlice(operation,raw,fields),
  };
}
