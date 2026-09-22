import type { ProviderObservation } from '../provider-observation/observation.ts';
import {
  validateObservationSlice,
  type CertifiedObservation,
  type ResponseFieldSpec,
  type SchemaResolver,
  type StructuralOperation,
} from '../provider-observation/response-slice.ts';
import {
  assertGcpAuthorityHost,
  gcpGet,
  type GcpJsonGet,
} from './gcp-rest.ts';

export interface GcpObservationOperation extends StructuralOperation {
  provider:'gcp';
  authority_host:string;
  api_version:string;
  method:'GET';
  path_template:string;
  schema_sha256:string;
}

export interface MaterializedGcpOperationRequest {
  path:string;
  parameters:Record<string,string|number|boolean>;
}

interface GcpObservationRequest {
  method:'GET';
  authority_host:string;
  path_template:string;
  path:string;
  parameters:Record<string,string|number|boolean>;
  headers:Record<string,string>;
  authorization:'bearer';
}

type GcpRawObservation=ProviderObservation<
  'gcp',
  GcpObservationRequest,
  Record<string,never>
>;

function validatedQuotaProject(value:string|undefined):string|undefined {
  if (value===undefined) return undefined;
  if (value.length===0 || /[\r\n"]/.test(value)) {
    throw new Error('GCP_QUOTA_PROJECT_INVALID');
  }
  return value;
}

export function observeCertifiedGcpRead200({
  accessToken,
  operation,
  request,
  fields,
  get=gcpGet,
  clock=()=>new Date().toISOString(),
  observerId,
  quotaProject,
  resolveRef,
}:{
  accessToken:string;
  operation:GcpObservationOperation;
  request:MaterializedGcpOperationRequest;
  fields:readonly ResponseFieldSpec[];
  get?:GcpJsonGet;
  clock?:()=>string;
  observerId:string;
  quotaProject?:string;
  resolveRef?:SchemaResolver;
}):{
  observed_at:string;
  certified:CertifiedObservation<GcpRawObservation>;
} {
  if (accessToken.length===0) throw new Error('GCP_ACCESS_TOKEN_REQUIRED');
  if (operation.provider!=='gcp') throw new Error('GCP_PROVIDER_MISMATCH');
  if (operation.method!=='GET') throw new Error('GCP_CERTIFIED_READ_REQUIRES_GET');
  if (operation.api_version.length===0) throw new Error('GCP_API_VERSION_REQUIRED');
  if (operation.path_template.length===0 || !operation.path_template.startsWith('/')) {
    throw new Error('GCP_PATH_TEMPLATE_INVALID');
  }
  if (!/^[0-9a-f]{64}$/.test(operation.schema_sha256)) {
    throw new Error('GCP_SCHEMA_DIGEST_INVALID');
  }
  const authorityHost=assertGcpAuthorityHost(operation.authority_host);
  if (!request.path.startsWith('/')) throw new Error('GCP_REQUEST_PATH_INVALID');

  const quota=validatedQuotaProject(quotaProject);
  const headers={
    Accept:'application/json',
    ...(quota===undefined?{}:{'X-Goog-User-Project':quota}),
  };
  const body=get(accessToken,{
    authority_host:authorityHost,
    path:request.path,
    headers,
  });
  const observedAt=clock();
  const raw:GcpRawObservation={
    contract:{
      provider:'gcp',
      api_version:operation.api_version,
      operation_id:operation.operation_id,
      schema_sha256:operation.schema_sha256,
    },
    observer:{kind:'gcp-rest',id:observerId},
    observed_at:observedAt,
    request:{
      method:'GET',
      authority_host:authorityHost,
      path_template:operation.path_template,
      path:request.path,
      parameters:request.parameters,
      headers,
      authorization:'bearer',
    },
    response:{},
    outcome:{status:200,visibility:'observed',value:body},
  };

  return {
    observed_at:observedAt,
    certified:validateObservationSlice(
      operation,
      raw,
      fields,
      resolveRef,
    ),
  };
}
