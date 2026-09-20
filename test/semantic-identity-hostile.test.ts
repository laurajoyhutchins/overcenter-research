import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIPT_SCHEMA,
  type Receipt,
  type State,
} from '../src/facts.ts';
import { canonicalDigest, sha256 } from '../src/digest.ts';
import type {
  Dependency,
  Obligation,
  Run,
} from '../src/model.ts';
import type { Lifecycle } from '../src/projector.ts';
import { obligationKey } from '../src/semantic-identity.ts';

const run=(obligationId:string):Run=>({
  id:`run-${obligationId}`,
  obligation_id:obligationId,
  claimed_revision:'revision',
  claim_commit:'claim',
  obligation_key:'prior-key',
  execution_generation:1,
  execution_authority_commit:'authority',
  execution_capability_sha256:'a'.repeat(64),
});

const fileObligation=(
  id:string,
  content:string,
  dependencies:Dependency[]=[],
  packet:Record<string,unknown>={},
):Obligation=>({
  id,
  dependencies,
  packet,
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/tmp/${id}`,
    content,
  },
});

const verifiedContent=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'output',selector:'verified-content'},
});

const settlementReceipt=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'evidence',selector:'settlement-receipt'},
});

const receipt=(
  upstreamRun:Run,
  disposition:Receipt['disposition']='DONE',
  settlementCommit:string|undefined='settlement-commit',
):Receipt=>({
  schema:RECEIPT_SCHEMA,
  run_id:upstreamRun.id,
  obligation_id:upstreamRun.obligation_id,
  claimed_revision:upstreamRun.claimed_revision,
  claim_commit:upstreamRun.claim_commit,
  execution_generation:upstreamRun.execution_generation,
  execution_authority_commit:upstreamRun.execution_authority_commit,
  kind:'observation',
  observed:null,
  settled_at:'2026-09-20T00:00:00.000Z',
  disposition,
  verified:disposition==='DONE',
  ...(settlementCommit===undefined?{}:{settlement_commit:settlementCommit}),
});

function fixture(
  upstream:Obligation,
  downstream:Obligation,
  lifecycle:Lifecycle|undefined,
  upstreamReceipt:Receipt|undefined,
){
  const state:State={
    obligations:{
      [upstream.id]:upstream,
      [downstream.id]:downstream,
    },
    definition_commits:{
      [upstream.id]:'definition-upstream',
      [downstream.id]:'definition-downstream',
    },
  };
  const lifecycles=new Map<string,Lifecycle>();
  if(lifecycle) lifecycles.set(upstream.id,lifecycle);
  const receipts=new Map<string,Receipt>();
  if(upstreamReceipt && lifecycle?.run) receipts.set(lifecycle.run.id,upstreamReceipt);
  return {state,lifecycles,receipts};
}

test('semantic identity rejects an unknown upstream before deriving any key',()=>{
  const downstream=fileObligation(
    'downstream',
    'B',
    [verifiedContent('missing')],
  );
  const state:State={
    obligations:{downstream},
    definition_commits:{downstream:'definition-downstream'},
  };

  assert.throws(
    ()=>obligationKey(state,downstream,new Map(),new Map()),
    /UNKNOWN_DEPENDENCY:missing/,
  );
});

test('semantic identity requires a DONE lifecycle with an exact run',()=>{
  const upstream=fileObligation('upstream','A');
  const downstream=fileObligation(
    'downstream',
    'B',
    [verifiedContent('upstream')],
  );
  const upstreamRun=run('upstream');

  const noLifecycle=fixture(
    upstream,
    downstream,
    undefined,
    undefined,
  );
  assert.equal(
    obligationKey(
      noLifecycle.state,
      downstream,
      noLifecycle.lifecycles,
      noLifecycle.receipts,
    ),
    null,
    'known upstream without a lifecycle is unresolved',
  );

  for(const status of [
    'UNREALIZED',
    'EXECUTING',
    'WAITING',
    'RECOVERY_REQUIRED',
  ] as const){
    const {state,lifecycles,receipts}=fixture(
      upstream,
      downstream,
      {status,run:upstreamRun},
      undefined,
    );
    assert.equal(
      obligationKey(state,downstream,lifecycles,receipts),
      null,
      `${status} must not establish semantic identity even if a run object is present`,
    );
  }

  const withoutRun=fixture(
    upstream,
    downstream,
    {status:'DONE'},
    undefined,
  );
  assert.equal(
    obligationKey(
      withoutRun.state,
      downstream,
      withoutRun.lifecycles,
      withoutRun.receipts,
    ),
    null,
    'DONE without an exact run is still unresolved',
  );
});

test('verified-content dependency binds the exact selected content identity',()=>{
  const upstream=fileObligation('upstream','A');
  const edge=verifiedContent('upstream');
  const downstream=fileObligation('downstream','B',[edge],{producer:'v1'});
  const upstreamRun=run('upstream');
  const {state,lifecycles,receipts}=fixture(
    upstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    undefined,
  );

  const observed=obligationKey(state,downstream,lifecycles,receipts);
  const expected=canonicalDigest({
    id:downstream.id,
    packet:downstream.packet,
    postcondition:downstream.postcondition,
    semantic_dependencies:[{
      consumes:{kind:'output',selector:'verified-content'},
      identity:`sha256:${sha256('A')}`,
    }],
  });

  assert.equal(observed,expected);

  const changedUpstream=fileObligation('upstream','A2');
  const changed=fixture(
    changedUpstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    undefined,
  );
  assert.notEqual(
    obligationKey(changed.state,downstream,changed.lifecycles,changed.receipts),
    observed,
    'changing the selected upstream content must change downstream identity',
  );
});

test('settlement-receipt dependency requires DONE disposition and a settlement commit',()=>{
  const upstream=fileObligation('upstream','A');
  const edge=settlementReceipt('upstream');
  const downstream=fileObligation('downstream','B',[edge]);
  const upstreamRun=run('upstream');

  const missing=fixture(
    upstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    undefined,
  );
  assert.equal(
    obligationKey(missing.state,downstream,missing.lifecycles,missing.receipts),
    null,
    'missing receipt cannot establish settlement identity',
  );

  for(const disposition of ['READY','WAITING','RECOVERY_REQUIRED'] as const){
    const candidate=receipt(upstreamRun,disposition,'settlement-commit');
    const f=fixture(
      upstream,
      downstream,
      {status:'DONE',run:upstreamRun},
      candidate,
    );
    assert.equal(
      obligationKey(f.state,downstream,f.lifecycles,f.receipts),
      null,
      `${disposition} receipt must not establish settlement identity`,
    );
  }

  const noCommit=receipt(upstreamRun,'DONE',undefined);
  const withoutCommit=fixture(
    upstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    noCommit,
  );
  assert.equal(
    obligationKey(
      withoutCommit.state,
      downstream,
      withoutCommit.lifecycles,
      withoutCommit.receipts,
    ),
    null,
    'DONE without settlement commit remains unresolved',
  );

  const settled=receipt(upstreamRun,'DONE','settlement-commit');
  const complete=fixture(
    upstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    settled,
  );
  const observed=obligationKey(
    complete.state,
    downstream,
    complete.lifecycles,
    complete.receipts,
  );
  const expected=canonicalDigest({
    id:downstream.id,
    packet:downstream.packet,
    postcondition:downstream.postcondition,
    semantic_dependencies:[{
      consumes:{kind:'evidence',selector:'settlement-receipt'},
      identity:'settlement:settlement-commit',
    }],
  });
  assert.equal(observed,expected);

  const other=receipt(upstreamRun,'DONE','other-settlement');
  const changed=fixture(
    upstream,
    downstream,
    {status:'DONE',run:upstreamRun},
    other,
  );
  assert.notEqual(
    obligationKey(changed.state,downstream,changed.lifecycles,changed.receipts),
    observed,
  );
});

test('semantic obligation key is order-independent but excludes control edges',()=>{
  const a=fileObligation('a','A');
  const b=fileObligation('b','B');
  const downstream=fileObligation('downstream','C',[
    verifiedContent('a'),
    {kind:'control',upstream:'b'},
    verifiedContent('b'),
  ]);
  const state:State={
    obligations:{a,b,downstream},
    definition_commits:{
      a:'definition-a',
      b:'definition-b',
      downstream:'definition-downstream',
    },
  };
  const lifecycles=new Map<string,Lifecycle>([
    ['a',{status:'DONE',run:run('a')}],
    ['b',{status:'DONE',run:run('b')}],
  ]);

  const first=obligationKey(state,downstream,lifecycles,new Map());
  assert.ok(first);

  const reordered:Obligation={
    ...downstream,
    dependencies:[
      verifiedContent('b'),
      verifiedContent('a'),
    ],
  };
  assert.equal(
    obligationKey(state,reordered,lifecycles,new Map()),
    first,
    'declaration order and satisfied control edges do not affect semantic identity',
  );
});

test('obligation key binds downstream id, packet, and postcondition',()=>{
  const upstream=fileObligation('upstream','A');
  const upstreamRun=run('upstream');
  const base=fileObligation(
    'downstream',
    'B',
    [verifiedContent('upstream')],
    {producer:'v1'},
  );
  const f=fixture(
    upstream,
    base,
    {status:'DONE',run:upstreamRun},
    undefined,
  );
  const key=obligationKey(f.state,base,f.lifecycles,f.receipts);
  assert.ok(key);

  const variants:Obligation[]=[
    {...base,id:'other-downstream'},
    {...base,packet:{producer:'v2'}},
    {...base,postcondition:{...base.postcondition,path:'/tmp/other'}},
  ];
  for(const variant of variants){
    assert.notEqual(
      obligationKey(f.state,variant,f.lifecycles,f.receipts),
      key,
    );
  }
});
