import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';

import {observationVerified,observePostcondition,observePostconditionAsync} from '../src/observation.ts';
import {
  certifyGithubStatusWebhook,
  GithubStatusMirror,
  type GithubWebhookAuthority,
  type GithubWebhookDeliveryLister,
} from '../src/providers/github-status-webhook.ts';

const SECRET='test-webhook-secret';
const SHA='a'.repeat(40);
const AUTHORITY:GithubWebhookAuthority={
  hook_id:9001,
  installation_target_id:7001,
  installation_target_type:'integration',
  installation_id:77,
};

function payload({
  id=1,
  state='success',
  context='overcenter/proof',
  updatedAt='2026-09-21T06:00:00Z',
  fullName='acme/widget',
  installationId=77,
}:{
  id?:number;
  state?:'error'|'failure'|'pending'|'success';
  context?:string;
  updatedAt?:string;
  fullName?:string;
  installationId?:number;
}={}):string {
  return JSON.stringify({
    id,
    sha:SHA,
    context,
    state,
    created_at:'2026-09-21T05:59:00Z',
    updated_at:updatedAt,
    repository:{
      id:42,
      full_name:fullName,
    },
    installation:{id:installationId},
  });
}

function signature(body:string):string {
  return `sha256=${createHmac('sha256',SECRET).update(body).digest('hex')}`;
}

function fact(
  body:string,
  deliveryId:string,
  overrides:Record<string,string>={},
) {
  return certifyGithubStatusWebhook({
    secret:SECRET,
    headers:{
      'x-hub-signature-256':signature(body),
      'x-github-event':'status',
      'x-github-delivery':deliveryId,
      'x-github-hook-id':String(AUTHORITY.hook_id),
      'x-github-hook-installation-target-id':String(AUTHORITY.installation_target_id),
      'x-github-hook-installation-target-type':AUTHORITY.installation_target_type,
      ...overrides,
    },
    body,
    receivedAt:'2026-09-21T06:00:01Z',
    expectedAuthority:AUTHORITY,
  });
}

function mirror(maxCoverageAgeMs=30_000):GithubStatusMirror {
  return new GithubStatusMirror(AUTHORITY,{maxCoverageAgeMs});
}

function delivery(
  guid:string,
  overrides:Record<string,unknown>={},
):Record<string,unknown> {
  return {
    id:Number.parseInt(guid.slice(0,8),16),
    guid,
    delivered_at:'2026-09-21T06:00:01Z',
    redelivery:false,
    duration:0.1,
    status:'OK',
    status_code:200,
    event:'status',
    action:null,
    installation_id:AUTHORITY.installation_id,
    repository_id:42,
    throttled_at:null,
    ...overrides,
  };
}

function pagesAt(
  observedAt:string,
  ...deliveryPages:Array<Array<Record<string,unknown>>>
):GithubWebhookDeliveryLister {
  return async({hookId,cursor})=>{
    assert.equal(hookId,AUTHORITY.hook_id);
    const index=cursor===null?0:Number(cursor);
    return {
      deliveries:deliveryPages[index]??[],
      next_cursor:index+1<deliveryPages.length?String(index+1):null,
      observed_at:observedAt,
    };
  };
}

function pages(
  ...deliveryPages:Array<Array<Record<string,unknown>>>
):GithubWebhookDeliveryLister {
  return pagesAt('2026-09-21T06:01:00Z',...deliveryPages);
}

async function reconcile(
  statusMirror:GithubStatusMirror,
  deliveries:Array<Record<string,unknown>>,
  observedAt='2026-09-21T06:01:00Z',
):Promise<void> {
  await statusMirror.reconcileRepository({
    repositoryId:42,
    list:pagesAt(observedAt,deliveries),
  });
}

test('signature verification happens before attacker-controlled JSON parsing',()=>{
  assert.throws(
    ()=>certifyGithubStatusWebhook({
      secret:SECRET,
      headers:{
        'x-hub-signature-256':`sha256=${'0'.repeat(64)}`,
        'x-github-event':'status',
        'x-github-delivery':'11111111-1111-1111-1111-111111111111',
      },
      body:'{not-json',
      receivedAt:'2026-09-21T06:00:01Z',
      expectedAuthority:AUTHORITY,
    }),
    /GITHUB_WEBHOOK_SIGNATURE_INVALID/,
  );

  const malformed='{not-json';
  assert.throws(
    ()=>certifyGithubStatusWebhook({
      secret:SECRET,
      headers:{
        'x-hub-signature-256':signature(malformed),
        'x-github-event':'status',
        'x-github-delivery':'11111111-1111-1111-1111-111111111111',
        'x-github-hook-id':String(AUTHORITY.hook_id),
        'x-github-hook-installation-target-id':String(AUTHORITY.installation_target_id),
        'x-github-hook-installation-target-type':AUTHORITY.installation_target_type,
      },
      body:malformed,
      receivedAt:'2026-09-21T06:00:01Z',
      expectedAuthority:AUTHORITY,
    }),
    /GITHUB_WEBHOOK_PAYLOAD_JSON_INVALID/,
  );
});

test('certification binds hook, installation target, installation, repository, and status identity',()=>{
  const body=payload();
  const certified=fact(
    body,
    '11111111-1111-1111-1111-111111111111',
  );

  assert.deepEqual(certified.authority,AUTHORITY);
  assert.equal(certified.repository.id,42);
  assert.equal(certified.repository.full_name,'acme/widget');
  assert.equal(certified.status.id,1);
  assert.equal(certified.status.commit_sha,SHA);
  assert.equal(certified.status.context,'overcenter/proof');
  assert.equal(certified.status.state,'success');
  assert.match(certified.payload_sha256,/^[0-9a-f]{64}$/);

  assert.throws(
    ()=>fact(
      body,
      '12111111-1111-1111-1111-111111111111',
      {'x-github-hook-id':'9002'},
    ),
    /GITHUB_WEBHOOK_AUTHORITY_MISMATCH/,
  );
  assert.throws(
    ()=>certifyGithubStatusWebhook({
      secret:SECRET,
      headers:{
        'x-hub-signature-256':signature(payload({installationId:78})),
        'x-github-event':'status',
        'x-github-delivery':'13111111-1111-1111-1111-111111111111',
        'x-github-hook-id':String(AUTHORITY.hook_id),
        'x-github-hook-installation-target-id':String(AUTHORITY.installation_target_id),
        'x-github-hook-installation-target-type':AUTHORITY.installation_target_type,
      },
      body:payload({installationId:78}),
      receivedAt:'2026-09-21T06:00:01Z',
      expectedAuthority:AUTHORITY,
    }),
    /GITHUB_WEBHOOK_INSTALLATION_ID_MISMATCH/,
  );
});

test('delivery identity is idempotent but cannot be reused for different bytes',()=>{
  const statusMirror=mirror();
  const deliveryId='22222222-2222-2222-2222-222222222222';
  const first=fact(payload(),deliveryId);
  assert.equal(statusMirror.ingest(first),'applied');
  assert.equal(statusMirror.ingest(first),'duplicate');

  const conflicting=fact(payload({id:2,state:'failure'}),deliveryId);
  assert.throws(
    ()=>statusMirror.ingest(conflicting),
    /GITHUB_WEBHOOK_DELIVERY_REUSE_MISMATCH/,
  );
});

test('mirror cannot claim continuity until provider delivery history reconciles',async()=>{
  const statusMirror=mirror();
  const deliveryId='33333333-3333-3333-3333-333333333333';
  statusMirror.ingest(fact(payload(),deliveryId));

  assert.deepEqual(
    statusMirror.observe({
      repositoryId:42,
      commitSha:SHA,
      context:'overcenter/proof',
      observedAt:'2026-09-21T06:00:10Z',
    }),
    {
      state:'indeterminate',
      reason:'GITHUB_STATUS_MIRROR_CONTINUITY_UNCERTIFIED',
    },
  );

  await reconcile(statusMirror,[delivery(deliveryId)]);
  const observed=statusMirror.observe({
    repositoryId:42,
    commitSha:SHA,
    context:'OVERCENTER/PROOF',
    observedAt:'2026-09-21T06:01:20Z',
  });
  assert.equal(observed.state,'present');
  if(observed.state==='present') {
    assert.equal(observed.actual_state,'success');
    assert.equal(observed.evidence.coverage_through,'2026-09-21T06:01:00Z');
    assert.equal(observed.evidence.coverage_valid_until,'2026-09-21T06:01:30.000Z');
    assert.equal(observed.evidence.hook_id,AUTHORITY.hook_id);
  }

  assert.deepEqual(
    statusMirror.observe({
      repositoryId:42,
      commitSha:SHA,
      context:'overcenter/proof',
      observedAt:'2026-09-21T06:01:31Z',
    }),
    {
      state:'indeterminate',
      reason:'GITHUB_STATUS_MIRROR_CONTINUITY_STALE',
    },
  );
});

test('failed GitHub delivery prevents continuity certification',async()=>{
  const statusMirror=mirror();
  const first='44444444-4444-4444-4444-444444444444';
  const lost='45444444-4444-4444-4444-444444444444';
  statusMirror.ingest(fact(payload(),first));

  await assert.rejects(
    statusMirror.reconcileRepository({
      repositoryId:42,
      list:pages([
        delivery(first),
        delivery(lost,{id:45,status:'Internal Server Error',status_code:500}),
      ]),
    }),
    new RegExp(`GITHUB_STATUS_MIRROR_DELIVERY_GAP:${lost}`),
  );
});

test('successful provider delivery missing from the mirror also prevents certification',async()=>{
  const statusMirror=mirror();
  const first='55555555-5555-5555-5555-555555555555';
  const acknowledgedButLost='56555555-5555-5555-5555-555555555555';
  statusMirror.ingest(fact(payload(),first));

  await assert.rejects(
    statusMirror.reconcileRepository({
      repositoryId:42,
      list:pages([
        delivery(first),
        delivery(acknowledgedButLost,{id:56,status_code:200}),
      ]),
    }),
    new RegExp(`GITHUB_STATUS_MIRROR_DELIVERY_GAP:${acknowledgedButLost}`),
  );
});

test('provider timestamps, not arrival order, determine current status after reconciliation',async()=>{
  const statusMirror=mirror();
  const newer='66666666-6666-6666-6666-666666666666';
  const older='67666666-6666-6666-6666-666666666666';
  statusMirror.ingest(fact(
    payload({
      id:2,
      state:'success',
      updatedAt:'2026-09-21T06:02:00Z',
      fullName:'renamed/widget',
    }),
    newer,
  ));
  assert.equal(
    statusMirror.ingest(fact(
      payload({
        id:1,
        state:'failure',
        updatedAt:'2026-09-21T06:01:00Z',
      }),
      older,
    )),
    'ignored',
  );

  await reconcile(
    statusMirror,
    [
      delivery(newer,{delivered_at:'2026-09-21T06:02:01Z'}),
      delivery(older,{delivered_at:'2026-09-21T06:01:01Z'}),
    ],
    '2026-09-21T06:03:00Z',
  );
  const observed=statusMirror.observe({
    repositoryId:42,
    commitSha:SHA,
    context:'overcenter/proof',
    observedAt:'2026-09-21T06:03:10Z',
  });
  assert.equal(observed.state,'present');
  if(observed.state==='present') {
    assert.equal(observed.actual_state,'success');
    assert.equal(observed.evidence.status_id,2);
    assert.equal(observed.evidence.canonical_repository_full_name,'renamed/widget');
  }
});

test('equal-time conflicting statuses remain ambiguous after complete reconciliation',async()=>{
  const statusMirror=mirror();
  const failure='77777777-7777-7777-7777-777777777777';
  const success='78777777-7777-7777-7777-777777777777';
  statusMirror.ingest(fact(payload({id:1,state:'failure'}),failure));
  assert.equal(
    statusMirror.ingest(fact(payload({id:2,state:'success'}),success)),
    'ambiguous',
  );

  await reconcile(statusMirror,[delivery(failure),delivery(success)]);
  assert.deepEqual(
    statusMirror.observe({
      repositoryId:42,
      commitSha:SHA,
      context:'overcenter/proof',
      observedAt:'2026-09-21T06:01:10Z',
    }),
    {
      state:'indeterminate',
      reason:'GITHUB_STATUS_MIRROR_ORDER_AMBIGUOUS',
    },
  );
});

test('reconciliation exhausts pagination before certifying coverage',async()=>{
  const statusMirror=mirror();
  const first='88888888-8888-8888-8888-888888888888';
  const second='89888888-8888-8888-8888-888888888888';
  statusMirror.ingest(fact(payload({id:1,state:'failure',updatedAt:'2026-09-21T05:59:00Z'}),first));
  statusMirror.ingest(fact(payload({id:2,state:'success'}),second));

  await statusMirror.reconcileRepository({
    repositoryId:42,
    list:pages([delivery(second)],[delivery(first)]),
  });
  assert.equal(
    statusMirror.observe({
      repositoryId:42,
      commitSha:SHA,
      context:'overcenter/proof',
      observedAt:'2026-09-21T06:01:10Z',
    }).state,
    'present',
  );
});

test('a reconciled mirror miss remains indeterminate rather than inventing absence',async()=>{
  const statusMirror=mirror();
  await reconcile(statusMirror,[]);
  assert.deepEqual(
    statusMirror.observe({
      repositoryId:42,
      commitSha:SHA,
      context:'missing',
      observedAt:'2026-09-21T06:01:10Z',
    }),
    {
      state:'indeterminate',
      reason:'GITHUB_STATUS_MIRROR_MISS',
    },
  );
});

test('ordinary GitHub status observation uses reconciled mirror without provider I/O',async()=>{
  const statusMirror=mirror();
  const deliveryId='99999999-9999-9999-9999-999999999999';
  statusMirror.ingest(fact(payload(),deliveryId));
  await reconcile(statusMirror,[delivery(deliveryId)]);

  let gets=0;
  const observed=observePostcondition({
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:42,
    repository_full_name:'acme/widget',
    commit_sha:SHA,
    context:'overcenter/proof',
    expected_state:'success',
  },{
    githubToken:null,
    githubStatusMirror:statusMirror,
    githubGet:()=>{
      gets+=1;
      throw new Error('provider GET must not run');
    },
    clock:()=> '2026-09-21T06:01:20Z',
  });

  assert.equal(gets,0);
  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observed.actual_state,'success');
  assert.equal(
    (observed.provider_evidence as Record<string,unknown>).source,
    'certified-webhook-mirror',
  );
  assert.equal(
    observationVerified({
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:42,
      repository_full_name:'acme/widget',
      commit_sha:SHA,
      context:'overcenter/proof',
      expected_state:'success',
    },observed),
    true,
  );
});


test('async GitHub status observation uses reconciled mirror without provider I/O',async()=>{
  const statusMirror=mirror();
  const deliveryId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  statusMirror.ingest(fact(payload(),deliveryId));
  await reconcile(statusMirror,[delivery(deliveryId)]);

  let gets=0;
  const observed=await observePostconditionAsync({
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:42,
    repository_full_name:'acme/widget',
    commit_sha:SHA,
    context:'overcenter/proof',
    expected_state:'success',
  },{
    githubToken:null,
    githubStatusMirror:statusMirror,
    githubGetAsync:async()=>{
      gets+=1;
      throw new Error('provider GET must not run');
    },
    clock:()=> '2026-09-21T06:01:20Z',
  });

  assert.equal(gets,0);
  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observed.actual_state,'success');
  assert.equal(
    (observed.provider_evidence as Record<string,unknown>).source,
    'certified-webhook-mirror',
  );
});
