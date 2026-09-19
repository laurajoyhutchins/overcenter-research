import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { KubernetesConfigMapExistsPostcondition } from '../../src/model.ts';
import {
  carryKubernetesAbsenceThroughWatch,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
  type KubernetesWatchContinuity,
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

function listPage(
  request:{namespace:string;continue_token:string|null;limit:number},
  next:string,
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
      authority_id:AUTHORITY,
      observer:{kind:'test',id:'lean-watch-differential'},
      observed_at:'2026-09-19T00:00:00.000Z',
      request:{
        namespace:request.namespace,
        continue_token:request.continue_token,
        limit:request.limit,
      },
      response:{},
      outcome:{
        status:200,
        visibility:'observed',
        value:{
          apiVersion:'v1',
          kind:'ConfigMapList',
          metadata:{resourceVersion:'500',continue:next},
          items:[],
        },
      },
    },
  };
}

const list:KubernetesListConfigMaps=request=>
  request.continue_token===null
    ? listPage(request,'token-1')
    : listPage(request,'');

const pages=[
  {
    authority_id:AUTHORITY,
    request_namespace:'proof',
    request_continue:null,
    response_continue:'token-1',
    snapshot_resource_version:'500',
    members:[],
  },
  {
    authority_id:AUTHORITY,
    request_namespace:'proof',
    request_continue:'token-1',
    response_continue:'',
    snapshot_resource_version:'500',
    members:[],
  },
];

type LeanEvent={
  type:'ADDED'|'MODIFIED'|'DELETED';
  member:{
    name:string;
    namespace:string;
    uid:string;
    resource_version:string;
  };
};

function targetEvent(type:LeanEvent['type'],rv:string):LeanEvent {
  return {
    type,
    member:{
      name:'target',
      namespace:'proof',
      uid:'uid-target',
      resource_version:rv,
    },
  };
}

function otherEvent(rv:string):LeanEvent {
  return {
    type:'MODIFIED',
    member:{
      name:'other',
      namespace:'proof',
      uid:'uid-other',
      resource_version:rv,
    },
  };
}

function leanCarry({
  authority=AUTHORITY,
  namespace='proof',
  start='500',
  termination='timeout',
  events=[],
}:{
  authority?:string;
  namespace?:string;
  start?:string;
  termination?:'client-stop'|'eof'|'timeout'|'gone'|'error';
  events?:LeanEvent[];
}):{state:string;snapshot_resource_version:string|null} {
  const request={
    command:'kubernetes-watch-carry',
    coordinate:{
      authority_id:AUTHORITY,
      namespace:'proof',
      name:'target',
    },
    snapshot_resource_version:'500',
    pages,
    watch:{
      authority_id:authority,
      request_namespace:namespace,
      start_resource_version:start,
      termination,
      events,
    },
  };
  return JSON.parse(execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  })) as {state:string;snapshot_resource_version:string|null};
}

test('Lean raw WATCH carry agrees with TypeScript summary semantics where inputs overlap',()=>{
  const observed=observeCertifiedKubernetesConfigMap(pc(),{list});
  assert.equal(observed.state,'absent');
  assert.ok(observed.absence_evidence);
  const base=observed.absence_evidence;

  const cases:Array<{
    name:string;
    ts:KubernetesWatchContinuity;
    lean:Parameters<typeof leanCarry>[0];
    expectedRv:string|null;
  }>=[
    {
      name:'continuous irrelevant event',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'501',
        continuity:'maintained',
        termination:'timeout',
        target_events:[],
      },
      lean:{events:[otherEvent('501')]},
      expectedRv:'501',
    },
    {
      name:'target added remains present',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'501',
        continuity:'maintained',
        termination:'timeout',
        target_events:['ADDED'],
      },
      lean:{events:[targetEvent('ADDED','501')]},
      expectedRv:null,
    },
    {
      name:'target added then deleted',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'502',
        continuity:'maintained',
        termination:'timeout',
        target_events:['ADDED','DELETED'],
      },
      lean:{
        events:[
          targetEvent('ADDED','501'),
          targetEvent('DELETED','502'),
        ],
      },
      expectedRv:'502',
    },
    {
      name:'watch gone',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'500',
        continuity:'broken-relist-required',
        termination:'gone',
        target_events:[],
      },
      lean:{termination:'gone'},
      expectedRv:null,
    },
    {
      name:'transport error',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'500',
        continuity:'broken-relist-required',
        termination:'error',
        target_events:[],
      },
      lean:{termination:'error'},
      expectedRv:null,
    },
    {
      name:'wrong authority',
      ts:{
        authority_id:'kind:other-cluster',
        namespace:'proof',
        start_resource_version:'500',
        last_resource_version:'500',
        continuity:'maintained',
        termination:'timeout',
        target_events:[],
      },
      lean:{authority:'kind:other-cluster'},
      expectedRv:null,
    },
    {
      name:'wrong namespace',
      ts:{
        authority_id:AUTHORITY,
        namespace:'other',
        start_resource_version:'500',
        last_resource_version:'500',
        continuity:'maintained',
        termination:'timeout',
        target_events:[],
      },
      lean:{namespace:'other'},
      expectedRv:null,
    },
    {
      name:'wrong starting resourceVersion',
      ts:{
        authority_id:AUTHORITY,
        namespace:'proof',
        start_resource_version:'499',
        last_resource_version:'500',
        continuity:'maintained',
        termination:'timeout',
        target_events:[],
      },
      lean:{start:'499'},
      expectedRv:null,
    },
  ];

  for(const candidate of cases) {
    const ts=carryKubernetesAbsenceThroughWatch(pc(),base,candidate.ts);
    const lean=leanCarry(candidate.lean);
    assert.equal(
      ts===null ? null : ts.snapshot?.resource_version,
      candidate.expectedRv,
      `${candidate.name}: TypeScript`,
    );
    assert.equal(
      lean.state,
      candidate.expectedRv===null?'RELIST_REQUIRED':'CARRIED',
      `${candidate.name}: Lean state`,
    );
    assert.equal(
      lean.snapshot_resource_version,
      candidate.expectedRv,
      `${candidate.name}: Lean resourceVersion`,
    );
  }
});
