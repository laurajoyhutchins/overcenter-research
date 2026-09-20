import { execFileSync } from 'node:child_process';
import { canonicalDigest } from '../../src/digest.ts';
import {
  KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
} from '../../src/providers/kubernetes-deployment.ts';

function kubectl(...args) {
  return execFileSync('kubectl',args,{
    encoding:'utf8',
    maxBuffer:32*1024*1024,
  }).trim();
}

export function currentClusterAuthority() {
  const config=JSON.parse(kubectl('config','view','--raw','-o','json'));
  const current=config.contexts?.find(
    item=>item.name===config['current-context'],
  );
  const clusterName=current?.context?.cluster;
  const cluster=config.clusters?.find(item=>item.name===clusterName)?.cluster;
  if(!clusterName || !cluster?.server) throw new Error('KUBERNETES_AUTHORITY_UNAVAILABLE');
  return `kubernetes:${canonicalDigest({
    server:cluster.server,
    certificate_authority_data:cluster['certificate-authority-data']??null,
    certificate_authority:cluster['certificate-authority']??null,
    insecure_skip_tls_verify:cluster['insecure-skip-tls-verify']??false,
  })}`;
}

export function deploymentReader(authorityId) {
  const discovery=JSON.parse(kubectl('get','--raw','/openapi/v3'));
  const appsUrl=discovery.paths?.['apis/apps/v1']?.serverRelativeURL;
  if(!appsUrl) throw new Error('KUBERNETES_APPS_V1_OPENAPI_UNAVAILABLE');

  const schemaDocument=JSON.parse(kubectl('get','--raw',appsUrl));
  const schemas=schemaDocument.components?.schemas??{};
  const operation=schemaDocument.paths?.[
    '/apis/apps/v1/namespaces/{namespace}/deployments/{name}'
  ]?.get;
  if(operation?.operationId!==KUBERNETES_DEPLOYMENT_GET_OPERATION_ID){
    throw new Error(`KUBERNETES_DEPLOYMENT_OPERATION_MISMATCH:${operation?.operationId??'missing'}`);
  }
  const responseSchema=operation.responses?.['200']
    ?.content?.['application/json']?.schema;
  if(!responseSchema) throw new Error('KUBERNETES_DEPLOYMENT_SCHEMA_UNAVAILABLE');

  const structuralOperation={
    operation_id:operation.operationId,
    outcomes:[{status:'200',schema:responseSchema}],
  };
  const resolveRef=ref=>{
    const prefix='#/components/schemas/';
    if(!ref.startsWith(prefix)) throw new Error(`KUBERNETES_OPENAPI_EXTERNAL_REF:${ref}`);
    const key=decodeURIComponent(
      ref.slice(prefix.length).replace(/~1/g,'/').replace(/~0/g,'~'),
    );
    const found=schemas[key];
    if(!found) throw new Error(`KUBERNETES_OPENAPI_REF_NOT_FOUND:${ref}`);
    return found;
  };
  const schemaSha256=canonicalDigest(schemaDocument);

  return (namespace,name)=>{
    const path=`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`;
    const body=JSON.parse(kubectl('get','--raw',path));
    return {
      operation:structuralOperation,
      resolve_ref:resolveRef,
      observation:{
        contract:{
          provider:'kubernetes',
          api_version:'v1',
          operation_id:KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
          schema_sha256:schemaSha256,
        },
        authority_id:authorityId,
        observer:{
          kind:'github-actions-kind',
          id:process.env.GITHUB_RUN_ID??'local',
        },
        observed_at:new Date().toISOString(),
        request:{namespace,name,path},
        response:{},
        outcome:{
          status:200,
          visibility:'observed',
          value:body,
        },
      },
    };
  };
}
