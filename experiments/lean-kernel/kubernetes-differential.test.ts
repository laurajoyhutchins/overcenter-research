import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { KubernetesConfigMapExistsPostcondition } from '../../src/model.ts';
import {
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../../src/providers/kubernetes-configmap.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';
const SCHEMA_SHA='a'.repeat(64);
const AUTHORITY='kind:test-cluster';

const operation={
  operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  outcomes:[{
    status:'200',
    schema:{
      type:'object',
      required:['apiVersion','kind','metadata','items'],
      properties:{
        apiVersion:{type:'string'},
        kind:{type:'string'},
        metadata:{
          type:'object',
          required:['resourceVersion'],
          properties:{
            resourceVersion:{type:'string'},
            continue:{type:'string'},
          },
        },
        items:{
          type:'array',
          items:{
            type:'object',
            required:['metadata'],
            properties:{
              metadata:{
                type:'object',
                required:['name','namespace','uid','resourceVersion'],
                properties:{
                  name:{type:'string'},
                  namespace:{type:'string'},
                  uid:{type:'string'},
                  resourceVersion:{type:'string'},
                },
              },
            },
          },
        },
      },
    },
  }],
};

type Member={
  name:string;
  namespace:string;
  uid:string;
  resourceVersion:string;
};

type RawPage={
  authority_id:string;
  request_namespace:string;
  request_continue:string|null;
  response_continue:string;
  snapshot_resource_version:string;
  members:Array<{
    name:string;
    namespace:string;
    uid:string;
    resource_version:string;
  }>;
};

function pc():KubernetesConfigMapExistsPostcondition {
  return {
    verifier:'kubernetes-configmap-exists/v1',
    provider:'kubernetes',
    authority_id:AUTHORITY,
    api_group:'',
    resource:'configmaps',
    namespace:'proof',
    name:'target',
  };
}

function page(
  request:{namespace:string;continue_token:string|null;limit:number},
  {
    rv='500',
    next='',
    items=[],
    status=200,
    authority=AUTHORITY,
    requestNamespace=request.namespace,
    requestContinue=request.continue_token,
  }:{
    rv?:string;
    next?:string;
    items?:Member[];
    status?:number;
    authority?:string;
    requestNamespace?:string;
    requestContinue?:string|null;
  }={},
):KubernetesConfigMapListRead {
  return {
    operation,
    observation:{
      contract:{
        provider:'kubernetes',
        api_version:'v1',
        operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
        schema_sha256:SCHEMA_SHA,
      },
      authority_id:authority,
      observer:{kind:'test',id:'lean-kernel-differential'},
      observed_at:'2026-09-19T00:00:00.000Z',
      request:{
        namespace:requestNamespace,
        continue_token:requestContinue,
        limit:request.limit,
      },
      response:{},
      outcome:status===200
        ? {
            status,
            visibility:'observed',
            value:{
              apiVersion:'v1',
              kind:'ConfigMapList',
              metadata:{resourceVersion:rv,continue:next},
              items:items.map(item=>({metadata:item})),
            },
          }
        : {
            status,
            visibility:'indeterminate',
          },
    },
  };
}

function rawPage({
  authority=AUTHORITY,
  requestNamespace='proof',
  requestContinue=null,
  responseContinue='',
  rv='500',
  members=[],
}:{
  authority?:string;
  requestNamespace?:string;
  requestContinue?:string|null;
  responseContinue?:string;
  rv?:string;
  members?:Member[];
}={}):RawPage {
  return {
    authority_id:authority,
    request_namespace:requestNamespace,
    request_continue:requestContinue,
    response_continue:responseContinue,
    snapshot_resource_version:rv,
    members:members.map(member=>({
      name:member.name,
      namespace:member.namespace,
      uid:member.uid,
      resource_version:member.resourceVersion,
    })),
  };
}

function lean(rawPages:RawPage[]):{state:string;disposition:string} {
  const request={
    command:'kubernetes-list',
    coordinate:{
      authority_id:AUTHORITY,
      namespace:'proof',
      name:'target',
    },
    snapshot_resource_version:'500',
    pages:rawPages,
  };
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout) as {state:string;disposition:string};
}

function expectedDisposition(state:'present'|'absent'|'indeterminate'):string {
  if(state==='present') return 'DONE';
  if(state==='absent') return 'READY';
  return 'RECOVERY_REQUIRED';
}

test('Lean and TypeScript classify the same Kubernetes LIST transcripts',()=>{
  const target:Member={
    name:'target',
    namespace:'proof',
    uid:'uid-target',
    resourceVersion:'499',
  };
  const wrongNamespace:Member={
    name:'other',
    namespace:'other',
    uid:'uid-other',
    resourceVersion:'498',
  };

  const cases:Array<{
    name:string;
    list:KubernetesListConfigMaps;
    pages:RawPage[];
  }>=[
    {
      name:'complete absence',
      list:request=>request.continue_token===null
        ? page(request,{next:'token-1'})
        : page(request),
      pages:[
        rawPage({responseContinue:'token-1'}),
        rawPage({requestContinue:'token-1'}),
      ],
    },
    {
      name:'target on second page',
      list:request=>request.continue_token===null
        ? page(request,{next:'token-1'})
        : page(request,{items:[target]}),
      pages:[
        rawPage({responseContinue:'token-1'}),
        rawPage({requestContinue:'token-1',members:[target]}),
      ],
    },
    {
      name:'resourceVersion drift',
      list:request=>request.continue_token===null
        ? page(request,{next:'token-1'})
        : page(request,{rv:'501'}),
      pages:[
        rawPage({responseContinue:'token-1'}),
        rawPage({requestContinue:'token-1',rv:'501'}),
      ],
    },
    {
      name:'broken continuation binding',
      list:request=>request.continue_token===null
        ? page(request,{next:'token-1'})
        : page(request,{requestContinue:'wrong'}),
      pages:[
        rawPage({responseContinue:'token-1'}),
        rawPage({requestContinue:'wrong'}),
      ],
    },
    {
      name:'wrong page authority',
      list:request=>page(request,{authority:'kind:other-cluster'}),
      pages:[
        rawPage({authority:'kind:other-cluster'}),
      ],
    },
    {
      name:'wrong requested namespace',
      list:request=>page(request,{requestNamespace:'other'}),
      pages:[
        rawPage({requestNamespace:'other'}),
      ],
    },
    {
      name:'member from wrong namespace',
      list:request=>page(request,{items:[wrongNamespace]}),
      pages:[
        rawPage({members:[wrongNamespace]}),
      ],
    },
    {
      name:'partial pagination',
      list:request=>{
        if(request.continue_token===null) return page(request,{next:'token-1'});
        throw new Error('TRANSPORT_INTERRUPTED');
      },
      pages:[
        rawPage({responseContinue:'token-1'}),
      ],
    },
    {
      name:'expired continuation',
      list:request=>request.continue_token===null
        ? page(request,{next:'expired-token'})
        : page(request,{status:410}),
      pages:[
        rawPage({responseContinue:'expired-token'}),
      ],
    },
  ];

  for(const candidate of cases) {
    const ts=observeCertifiedKubernetesConfigMap(pc(),{list:candidate.list});
    const leanResult=lean(candidate.pages);
    assert.equal(
      leanResult.state,
      ts.state.toUpperCase(),
      `${candidate.name}: state`,
    );
    assert.equal(
      leanResult.disposition,
      expectedDisposition(ts.state),
      `${candidate.name}: disposition`,
    );
  }
});
