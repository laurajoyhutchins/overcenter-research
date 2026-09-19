import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest } from '../../src/digest.ts';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';
import type { KubernetesConfigMapExistsPostcondition } from '../../src/model.ts';
import {
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  type KubernetesListConfigMaps,
} from '../../src/providers/kubernetes/configmap.ts';
import type { SchemaResolver, StructuralOperation } from '../../src/observation/response-slice.ts';

const namespace='overcenter-core-proof';
const target='target';
const distractor='distractor';

function kubectl(...args:string[]):string {
  return execFileSync('kubectl',args,{
    encoding:'utf8',
    maxBuffer:32*1024*1024,
  }).trim();
}

function currentClusterAuthority():string {
  const config=JSON.parse(
    kubectl('config','view','--raw','-o','json'),
  ) as {
    'current-context'?:string;
    contexts?:Array<{name?:string;context?:{cluster?:string}}>;
    clusters?:Array<{
      name?:string;
      cluster?:{
        server?:string;
        'certificate-authority-data'?:string;
        'certificate-authority'?:string;
        'insecure-skip-tls-verify'?:boolean;
      };
    }>;
  };
  const current=config.contexts?.find(
    item=>item.name===config['current-context'],
  );
  const clusterName=current?.context?.cluster;
  const cluster=config.clusters?.find(item=>item.name===clusterName)?.cluster;
  assert.ok(clusterName && cluster?.server,'current Kubernetes cluster authority');
  return `kubernetes:${canonicalDigest({
    server:cluster.server,
    certificate_authority_data:cluster['certificate-authority-data']??null,
    certificate_authority:cluster['certificate-authority']??null,
    insecure_skip_tls_verify:cluster['insecure-skip-tls-verify']??false,
  })}`;
}

kubectl('delete','namespace',namespace,'--ignore-not-found=true','--wait=true');
kubectl('create','namespace',namespace);
try {
  kubectl(
    'create','configmap',distractor,
    '-n',namespace,
    '--from-literal=value=other',
  );

  const discovery=JSON.parse(
    kubectl('get','--raw','/openapi/v3'),
  ) as {paths?:Record<string,{serverRelativeURL?:string}>};
  const coreUrl=discovery.paths?.['api/v1']?.serverRelativeURL;
  assert.ok(coreUrl,'core/v1 OpenAPI discovery URL');

  const schemaText=kubectl('get','--raw',coreUrl);
  const schemaDocument=JSON.parse(schemaText) as {
    components?:{schemas?:Record<string,unknown>};
    paths?:Record<string,{
      get?:{
        operationId?:string;
        responses?:Record<string,{
          content?:Record<string,{schema?:unknown}>;
        }>;
      };
    }>;
  };
  const schemas=schemaDocument.components?.schemas??{};
  const listOperation=schemaDocument.paths?.[
    '/api/v1/namespaces/{namespace}/configmaps'
  ]?.get;
  assert.equal(
    listOperation?.operationId,
    KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
    'namespaced ConfigMap LIST operation identity',
  );
  const listSchema=listOperation?.responses?.['200']
    ?.content?.['application/json']?.schema;
  assert.ok(listSchema,'namespaced ConfigMap LIST response schema');

  const operation:StructuralOperation={
    operation_id:listOperation.operationId,
    outcomes:[{status:'200',schema:listSchema}],
  };
  const resolveRef:SchemaResolver=ref=>{
    const prefix='#/components/schemas/';
    if (!ref.startsWith(prefix)) {
      throw new Error(`KUBERNETES_OPENAPI_EXTERNAL_REF:${ref}`);
    }
    const key=decodeURIComponent(
      ref.slice(prefix.length).replace(/~1/g,'/').replace(/~0/g,'~'),
    );
    const found=schemas[key];
    if (!found) throw new Error(`KUBERNETES_OPENAPI_REF_NOT_FOUND:${ref}`);
    return found;
  };

  const authorityId=currentClusterAuthority();
  let observedPages=0;
  const list:KubernetesListConfigMaps=request=>{
    assert.equal(request.authority_id,authorityId);
    const query=new URLSearchParams({limit:String(request.limit)});
    if (request.continue_token!==null) {
      query.set('continue',request.continue_token);
    }
    const path=`/api/v1/namespaces/${encodeURIComponent(request.namespace)}/configmaps?${query}`;
    const body=JSON.parse(kubectl('get','--raw',path));
    observedPages+=1;
    return {
      operation,
      resolve_ref:resolveRef,
      observation:{
        contract:{
          provider:'kubernetes',
          api_version:'v1',
          operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
          schema_sha256:canonicalDigest(schemaDocument),
        },
        authority_id:authorityId,
        observer:{
          kind:'github-actions-kind',
          id:process.env.GITHUB_RUN_ID??'local',
        },
        observed_at:new Date().toISOString(),
        request:{
          namespace:request.namespace,
          continue_token:request.continue_token,
          limit:request.limit,
          path,
        },
        response:{},
        outcome:{
          status:200,
          visibility:'observed',
          value:body,
        },
      },
    };
  };

  const root=mkdtempSync(join(tmpdir(),'overcenter-kubernetes-core-live-'));
  try {
    const repo=join(root,'repo');
    execFileSync('git',['init',repo],{stdio:'ignore'});
    execFileSync('git',['-C',repo,'config','user.email','proof@example.com']);
    execFileSync('git',['-C',repo,'config','user.name','Proof']);

    const postcondition:KubernetesConfigMapExistsPostcondition={
      verifier:'kubernetes-configmap-exists/v1',
      provider:'kubernetes',
      authority_id:authorityId,
      api_group:'',
      resource:'configmaps',
      namespace,
      name:target,
    };
    const observationContext={
      kubernetesListConfigMaps:list,
      kubernetesListLimit:1,
    };

    const kernel=new GitOvercenterKernel(repo,{observationContext});
    kernel.initialize();
    kernel.define({
      id:'ensure-configmap',
      packet:{provider:'kubernetes',namespace,name:target},
      postcondition,
    });

    const first=kernel.claim(
      'ensure-configmap',
      kernel.deriveReadyWork()!.revision,
    );
    const absent=kernel.resolve(first);

    assert.equal(absent.disposition,'READY');
    assert.equal(absent.observed?.mutation_certainty,'absent');
    assert.equal(
      absent.observed?.absence_evidence?.kind,
      'kubernetes-complete-list-absence/v1',
    );
    const pageCount=absent.observed?.absence_evidence?.completeness.page_count;
    assert.equal(typeof pageCount,'number');
    assert.ok((pageCount as number)>=2,'live LIST exercised pagination');

    const second=kernel.claim(
      'ensure-configmap',
      kernel.deriveReadyWork()!.revision,
    );
    await kernel.performEffect(second,()=>{
      kubectl(
        'create','configmap',target,
        '-n',namespace,
        '--from-literal=value=created-by-safe-replay',
      );
    });
    const done=kernel.resolve(second);

    assert.equal(done.disposition,'DONE');
    assert.equal(done.verified,true);
    assert.equal(done.observed?.mutation_certainty,'present');
    assert.equal(kernel.inspect()[0].status,'DONE');

    const reconstructed=new GitOvercenterKernel(repo,{observationContext});
    assert.equal(reconstructed.inspect()[0].status,'DONE');
    assert.equal(
      reconstructed.receipts(first.id)[0].observed?.absence_evidence?.kind,
      'kubernetes-complete-list-absence/v1',
    );

    console.log(JSON.stringify({
      result:'PASS',
      authority_id:authorityId,
      list_pages_observed:observedPages,
      absence:{
        disposition:absent.disposition,
        snapshot_resource_version:
          absent.observed?.absence_evidence?.snapshot?.resource_version,
        page_count:pageCount,
      },
      replay:{
        disposition:done.disposition,
        observed_uid:done.observed?.observed_uid,
        observed_resource_version:done.observed?.observed_resource_version,
      },
      reconstruction:{
        status:reconstructed.inspect()[0].status,
      },
    },null,2));
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
} finally {
  kubectl('delete','namespace',namespace,'--ignore-not-found=true','--wait=true');
}
