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

type WatchEvent={
  type:'ADDED'|'MODIFIED'|'DELETED';
  member:Member;
};

type Watch={
  authority_id:string;
  request_namespace:string;
  start_resource_version:string;
  termination:'client-stop'|'eof'|'timeout'|'gone'|'error';
  events:WatchEvent[];
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

function member(name:string,rv:string,overrides:Partial<Member>={}):Member {
  return {
    name,
    namespace:'proof',
    uid:`uid-${name}`,
    resource_version:rv,
    ...overrides,
  };
}

const basePages:Page[]=[
  page({response_continue:'token-1'}),
  page({request_continue:'token-1'}),
];

function watch(overrides:Partial<Watch>={}):Watch {
  return {
    authority_id:'kind:test-cluster',
    request_namespace:'proof',
    start_resource_version:'500',
    termination:'timeout',
    events:[],
    ...overrides,
  };
}

function carry(
  transcript:Watch,
  pages:Page[]=basePages,
):{schema:string;state:string;snapshot_resource_version:string|null} {
  const request={
    command:'kubernetes-watch-carry',
    coordinate:{
      authority_id:'kind:test-cluster',
      namespace:'proof',
      name:'target',
    },
    snapshot_resource_version:'500',
    pages,
    watch:transcript,
  };
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout) as {
    schema:string;
    state:string;
    snapshot_resource_version:string|null;
  };
}

test('WATCH carries complete LIST absence through irrelevant events',()=>{
  assert.deepEqual(
    carry(watch({
      events:[{
        type:'MODIFIED',
        member:member('other','501'),
      }],
    })),
    {
      schema:'overcenter-lean-kernel/v1',
      state:'CARRIED',
      snapshot_resource_version:'501',
    },
  );
});

test('WATCH target-state fold requires target to end absent',()=>{
  const added=carry(watch({
    events:[{
      type:'ADDED',
      member:member('target','501'),
    }],
  }));
  assert.equal(added.state,'RELIST_REQUIRED');

  const deleted=carry(watch({
    events:[
      {
        type:'ADDED',
        member:member('target','501'),
      },
      {
        type:'DELETED',
        member:member('target','502'),
      },
    ],
  }));
  assert.deepEqual(deleted,{
    schema:'overcenter-lean-kernel/v1',
    state:'CARRIED',
    snapshot_resource_version:'502',
  });
});

test('WATCH continuity hostile cases require relist',()=>{
  const hostile:Array<{name:string;watch:Watch;pages?:Page[]}>= [
    {
      name:'410 Gone equivalent',
      watch:watch({termination:'gone'}),
    },
    {
      name:'transport error',
      watch:watch({termination:'error'}),
    },
    {
      name:'wrong authority',
      watch:watch({authority_id:'kind:other-cluster'}),
    },
    {
      name:'wrong namespace',
      watch:watch({request_namespace:'other'}),
    },
    {
      name:'wrong start resourceVersion',
      watch:watch({start_resource_version:'499'}),
    },
    {
      name:'invalid event namespace',
      watch:watch({
        events:[{
          type:'MODIFIED',
          member:member('other','501',{namespace:'other'}),
        }],
      }),
    },
    {
      name:'invalid event uid',
      watch:watch({
        events:[{
          type:'MODIFIED',
          member:member('other','501',{uid:''}),
        }],
      }),
    },
    {
      name:'base LIST was incomplete',
      watch:watch(),
      pages:[page({response_continue:'token-1'})],
    },
    {
      name:'base LIST contained target',
      watch:watch(),
      pages:[
        page({response_continue:'token-1'}),
        page({
          request_continue:'token-1',
          members:[member('target','499')],
        }),
      ],
    },
  ];

  for(const candidate of hostile) {
    assert.equal(
      carry(candidate.watch,candidate.pages).state,
      'RELIST_REQUIRED',
      candidate.name,
    );
  }
});
