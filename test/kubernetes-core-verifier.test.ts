import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import type { KubernetesConfigMapExistsPostcondition } from '../src/model.ts';
import {
  carryKubernetesAbsenceThroughWatch,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  kubernetesConfigMapAbsenceEvidenceMatches,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../src/providers/kubernetes-configmap.ts';

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

function pc(
  namespace='proof',
  name='target',
):KubernetesConfigMapExistsPostcondition {
  return {
    verifier:'kubernetes-configmap-exists/v1',
    provider:'kubernetes',
    authority_id:AUTHORITY,
    api_group:'',
    resource:'configmaps',
    namespace,
    name,
  };
}

function page(
  request:{
    namespace:string;
    continue_token:string|null;
    limit:number;
  },
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
    items?:Array<{name:string;namespace:string;uid:string;resourceVersion:string}>;
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
      observer:{kind:'test',id:'kubernetes-core-verifier'},
      observed_at:'2026-09-18T19:30:00.000Z',
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

function pagedAbsence():KubernetesListConfigMaps {
  return request=>request.continue_token===null
    ? page(request,{rv:'500',next:'token-1'})
    : page(request,{rv:'500',next:''});
}

function fixture(list:KubernetesListConfigMaps) {
  const root=mkdtempSync(join(tmpdir(),'overcenter-kube-core-'));
  const repo=join(root,'repo');
  execFileSync('git',['init',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'config','user.email','test@example.com']);
  execFileSync('git',['-C',repo,'config','user.name','Test']);
  const kernel=new GitOvercenterKernel(repo,{
    observationContext:{kubernetesListConfigMaps:list},
  });
  kernel.initialize();
  return {root,kernel};
}

test('complete Kubernetes LIST absence drives generic settlement to READY and later presence to DONE',()=>{
  let present=false;
  const list:KubernetesListConfigMaps=request=>{
    if (!present) return pagedAbsence()(request);
    return page(request,{
      rv:'501',
      next:'',
      items:[{
        name:'target',
        namespace:'proof',
        uid:'uid-target',
        resourceVersion:'501',
      }],
    });
  };

  const f=fixture(list);
  try {
    f.kernel.define({id:'ensure-configmap',postcondition:pc()});
    const first=f.kernel.claim(
      'ensure-configmap',
      f.kernel.nextReadyWork()!.revision,
    );
    const absent=f.kernel.resolve(first);

    assert.equal(absent.disposition,'READY');
    assert.equal(absent.verified,false);
    assert.equal(absent.observed?.mutation_certainty,'absent');
    assert.equal(
      absent.observed?.absence_evidence?.kind,
      'kubernetes-complete-list-absence/v1',
    );
    assert.equal(
      absent.observed?.absence_evidence?.completeness.page_count,
      2,
    );
    assert.equal(f.kernel.inspect()[0].status,'READY');

    present=true;
    const second=f.kernel.claim(
      'ensure-configmap',
      f.kernel.nextReadyWork()!.revision,
    );
    const done=f.kernel.resolve(second);
    assert.equal(done.disposition,'DONE');
    assert.equal(done.verified,true);
    assert.equal(done.observed?.observed_uid,'uid-target');
    assert.equal(f.kernel.inspect()[0].status,'DONE');
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('partial pagination cannot mint absence',()=>{
  let calls=0;
  const result=observeCertifiedKubernetesConfigMap(pc(),{
    list:request=>{
      calls+=1;
      if (calls===1) return page(request,{rv:'500',next:'token-1'});
      throw new Error('TRANSPORT_INTERRUPTED');
    },
  });
  assert.equal(result.state,'indeterminate');
  assert.equal(result.reason,'TRANSPORT_INTERRUPTED');
  assert.equal(result.absence_evidence,undefined);
});

test('expired continuation fails closed instead of minting absence',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{
    list:request=>request.continue_token===null
      ? page(request,{rv:'500',next:'expired-token'})
      : page(request,{status:410}),
  });
  assert.equal(result.state,'indeterminate');
  assert.equal(result.reason,'KUBERNETES_CONTINUATION_EXPIRED');
  assert.equal(result.absence_evidence,undefined);
});

test('resourceVersion drift across LIST pages fails closed',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{
    list:request=>request.continue_token===null
      ? page(request,{rv:'500',next:'token-1'})
      : page(request,{rv:'501',next:''}),
  });
  assert.equal(result.state,'indeterminate');
  assert.equal(result.reason,'KUBERNETES_LIST_RESOURCE_VERSION_CHANGED');
});

test('transport coordinate mismatch fails closed',()=>{
  const wrongNamespace=observeCertifiedKubernetesConfigMap(pc(),{
    list:request=>page(request,{requestNamespace:'other'}),
  });
  assert.equal(wrongNamespace.state,'indeterminate');
  assert.equal(
    wrongNamespace.reason,
    'KUBERNETES_LIST_OBSERVATION_COORDINATE_MISMATCH',
  );

  const wrongAuthority=observeCertifiedKubernetesConfigMap(pc(),{
    list:request=>page(request,{authority:'kind:other-cluster'}),
  });
  assert.equal(wrongAuthority.state,'indeterminate');
  assert.equal(
    wrongAuthority.reason,
    'KUBERNETES_LIST_OBSERVATION_COORDINATE_MISMATCH',
  );
});

test('absence certificate cannot cross namespace or name coordinates',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{list:pagedAbsence()});
  assert.equal(result.state,'absent');
  assert.ok(result.absence_evidence);

  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(result.absence_evidence,pc()),
    true,
  );
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(
      result.absence_evidence,
      pc('other','target'),
    ),
    false,
  );
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(
      result.absence_evidence,
      pc('proof','other'),
    ),
    false,
  );
});

test('durable LIST page-chain tampering cannot authorize absence',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{list:pagedAbsence()});
  assert.equal(result.state,'absent');
  assert.ok(result.absence_evidence);

  const badDigest=structuredClone(result.absence_evidence);
  badDigest.completeness.page_chain_digest=`sha256:${'0'.repeat(64)}`;
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(badDigest,pc()),
    false,
  );

  const brokenChain=structuredClone(result.absence_evidence);
  const pages=brokenChain.provenance.pages as Array<Record<string,unknown>>;
  pages[1].request_continue='wrong-token';
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(brokenChain,pc()),
    false,
  );
});

test('broken WATCH continuity cannot carry LIST absence forward',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{list:pagedAbsence()});
  assert.equal(result.state,'absent');
  assert.ok(result.absence_evidence);

  const broken=carryKubernetesAbsenceThroughWatch(
    pc(),
    result.absence_evidence,
    {
      authority_id:AUTHORITY,
      namespace:'proof',
      start_resource_version:'500',
      last_resource_version:'510',
      continuity:'broken-relist-required',
      termination:'gone',
      target_events:[],
    },
  );
  assert.equal(broken,null);

  const continuous=carryKubernetesAbsenceThroughWatch(
    pc(),
    result.absence_evidence,
    {
      authority_id:AUTHORITY,
      namespace:'proof',
      start_resource_version:'500',
      last_resource_version:'510',
      continuity:'maintained',
      termination:'timeout',
      target_events:[],
    },
  );
  assert.ok(continuous);
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(continuous,pc()),
    true,
  );

  const forged=structuredClone(continuous);
  forged.completeness.watch_continuity='broken-relist-required';
  assert.equal(
    kubernetesConfigMapAbsenceEvidenceMatches(forged,pc()),
    false,
  );
});

test('WATCH evidence that observes target presence cannot preserve absence',()=>{
  const result=observeCertifiedKubernetesConfigMap(pc(),{list:pagedAbsence()});
  assert.equal(result.state,'absent');
  assert.ok(result.absence_evidence);

  const noLongerAbsent=carryKubernetesAbsenceThroughWatch(
    pc(),
    result.absence_evidence,
    {
      authority_id:AUTHORITY,
      namespace:'proof',
      start_resource_version:'500',
      last_resource_version:'511',
      continuity:'maintained',
      termination:'timeout',
      target_events:['ADDED'],
    },
  );
  assert.equal(noLongerAbsent,null);
});
