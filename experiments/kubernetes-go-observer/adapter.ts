import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  KubernetesConfigMapListRead,
  KubernetesListConfigMaps,
} from '../../src/providers/kubernetes-configmap.ts';
import type {
  SchemaResolver,
  StructuralOperation,
} from '../../src/provider-observation/response-slice.ts';

export interface GoKubernetesListTrace {
  schema:'overcenter.kubernetes-list-trace/v1';
  provider:'kubernetes';
  api_version:'v1';
  operation_id:'listCoreV1NamespacedConfigMap';
  authority_id:string;
  namespace:string;
  limit:number;
  pages:Array<{
    observed_at:string;
    request:{
      namespace:string;
      continue_token:string|null;
      limit:number;
      path:string;
    };
    response:{
      status:number;
      body_base64:string;
      body_sha256:string;
    };
  }>;
}

function decodeExactBody(
  response:GoKubernetesListTrace['pages'][number]['response'],
):Buffer {
  const body=Buffer.from(response.body_base64,'base64');
  if (body.toString('base64')!==response.body_base64) {
    throw new Error('KUBERNETES_GO_TRACE_BODY_BASE64_INVALID');
  }
  const digest=`sha256:${createHash('sha256').update(body).digest('hex')}`;
  if (digest!==response.body_sha256) {
    throw new Error('KUBERNETES_GO_TRACE_BODY_DIGEST_MISMATCH');
  }
  return body;
}

export function kubernetesListFromGoTrace(
  trace:GoKubernetesListTrace,
  {
    operation,
    schemaSha256,
    resolveRef,
    observerId='go-kubernetes-list-trace',
  }:{
    operation:StructuralOperation;
    schemaSha256:string;
    resolveRef?:SchemaResolver;
    observerId?:string;
  },
):KubernetesListConfigMaps {
  if (
    trace.schema!=='overcenter.kubernetes-list-trace/v1'
    || trace.provider!=='kubernetes'
    || trace.api_version!=='v1'
    || trace.operation_id!=='listCoreV1NamespacedConfigMap'
    || operation.operation_id!==trace.operation_id
    || trace.authority_id.length===0
    || trace.namespace.length===0
    || !Number.isSafeInteger(trace.limit)
    || trace.limit<=0
  ) {
    throw new Error('KUBERNETES_GO_TRACE_IDENTITY_INVALID');
  }

  const pagesByContinue=new Map<string,GoKubernetesListTrace['pages'][number]>();
  for (const page of trace.pages) {
    const key=page.request.continue_token===null
      ? 'null'
      : `token:${page.request.continue_token}`;
    if (pagesByContinue.has(key)) {
      throw new Error('KUBERNETES_GO_TRACE_DUPLICATE_REQUEST');
    }
    pagesByContinue.set(key,page);
  }

  return request=>{
    const key=request.continue_token===null
      ? 'null'
      : `token:${request.continue_token}`;
    const page=pagesByContinue.get(key);
    if (!page) throw new Error('KUBERNETES_GO_TRACE_PAGE_MISSING');

    const body=decodeExactBody(page.response);
    const status=page.response.status;
    let value:unknown;
    if (status===200) {
      try {
        value=JSON.parse(body.toString('utf8'));
      } catch {
        throw new Error('KUBERNETES_GO_TRACE_SUCCESS_BODY_NOT_JSON');
      }
    }

    const read:KubernetesConfigMapListRead={
      operation,
      resolve_ref:resolveRef,
      observation:{
        contract:{
          provider:'kubernetes',
          api_version:'v1',
          operation_id:trace.operation_id,
          schema_sha256:schemaSha256,
        },
        authority_id:trace.authority_id,
        observer:{kind:'go-http-observer',id:observerId},
        observed_at:page.observed_at,
        request:{
          namespace:page.request.namespace,
          continue_token:page.request.continue_token,
          limit:page.request.limit,
          path:page.request.path,
        },
        response:{
          body_sha256:page.response.body_sha256,
        },
        outcome:status===200
          ? {
              status,
              visibility:'observed',
              value,
            }
          : {
              status,
              visibility:'indeterminate',
            },
      },
    };
    return read;
  };
}
