import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';

type Member={
  name:string;
  namespace:string;
  uid:string;
  resource_version:string;
};

type Page={
  authority_id:string;
  request_namespace:string;
  request_continue:string|null;
  response_continue:string;
  snapshot_resource_version:string;
  members:Member[];
};

function page(overrides:Partial<Page>={}):Page {
  return {
    authority_id:'kind:test-cluster',
    request_namespace:'proof',
    request_continue:null,
    response_continue:'',
    snapshot_resource_version:'500',
    members:[],
    ...overrides,
  };
}

function disposition(pages:Page[],evidenceOverrides:Record<string,unknown>={}):string {
  const request={
    command:'settle',
    postcondition:{
      family:'kubernetes-configmap-exists',
      verifier_revision:'kubernetes-configmap-exists/v1@semantics-1',
      coordinate:{
        authority_id:'kind:test-cluster',
        namespace:'proof',
        name:'target',
      },
      expected:'exists',
    },
    observation:{
      family:'kubernetes-configmap-exists',
      verifier_revision:'kubernetes-configmap-exists/v1@semantics-1',
      coordinate:{
        authority_id:'kind:test-cluster',
        namespace:'proof',
        name:'target',
      },
      certainty:'absent',
      actual:null,
      absence:{
        kind:'kubernetes-complete-list-absence/v1',
        authority_id:'kind:test-cluster',
        namespace:'proof',
        name:'target',
        snapshot_resource_version:'500',
        pages,
        ...evidenceOverrides,
      },
    },
  };
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return (JSON.parse(stdout) as {disposition:string}).disposition;
}

test('complete two-page Kubernetes LIST proves authoritative absence',()=>{
  assert.equal(disposition([
    page({response_continue:'token-1'}),
    page({request_continue:'token-1'}),
  ]),'READY');
});

test('Kubernetes LIST hostile pagination cases fail closed at the Lean boundary',()=>{
  const complete=[
    page({response_continue:'token-1'}),
    page({request_continue:'token-1'}),
  ];

  const cases=[
    {
      name:'partial pagination',
      pages:[page({response_continue:'token-1'})],
    },
    {
      name:'broken continuation chain',
      pages:[
        page({response_continue:'token-1'}),
        page({request_continue:'wrong'}),
      ],
    },
    {
      name:'resourceVersion drift',
      pages:[
        page({response_continue:'token-1'}),
        page({request_continue:'token-1',snapshot_resource_version:'501'}),
      ],
    },
    {
      name:'target hidden on later page',
      pages:[
        page({response_continue:'token-1'}),
        page({
          request_continue:'token-1',
          members:[{
            name:'target',
            namespace:'proof',
            uid:'uid-target',
            resource_version:'499',
          }],
        }),
      ],
    },
    {
      name:'wrong page authority',
      pages:[
        page({authority_id:'kind:other-cluster',response_continue:'token-1'}),
        page({request_continue:'token-1'}),
      ],
    },
    {
      name:'wrong request namespace',
      pages:[
        page({request_namespace:'other',response_continue:'token-1'}),
        page({request_continue:'token-1'}),
      ],
    },
    {
      name:'wrong namespace member',
      pages:[
        page({
          response_continue:'token-1',
          members:[{
            name:'other',
            namespace:'other',
            uid:'uid-other',
            resource_version:'498',
          }],
        }),
        page({request_continue:'token-1'}),
      ],
    },
    {
      name:'member without stable uid',
      pages:[
        page({
          response_continue:'token-1',
          members:[{
            name:'other',
            namespace:'proof',
            uid:'',
            resource_version:'498',
          }],
        }),
        page({request_continue:'token-1'}),
      ],
    },
  ];

  for(const candidate of cases) {
    assert.equal(
      disposition(candidate.pages),
      'RECOVERY_REQUIRED',
      candidate.name,
    );
  }

  assert.equal(
    disposition(complete,{authority_id:'kind:other-cluster'}),
    'RECOVERY_REQUIRED',
    'wrong authority',
  );
  assert.equal(
    disposition(complete,{namespace:'other'}),
    'RECOVERY_REQUIRED',
    'wrong namespace',
  );
  assert.equal(
    disposition(complete,{name:'other'}),
    'RECOVERY_REQUIRED',
    'wrong target name',
  );
});
