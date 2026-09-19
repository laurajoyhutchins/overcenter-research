import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  CLAIM_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
} from '../../src/facts.ts';
import type {
  FactCommit,
  ObligationFact,
  ReceiptFact,
  State,
} from '../../src/facts.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { obligationKey } from '../../src/lifecycle.ts';
import { validateGraph } from '../../src/graph.ts';
import type {
  Dependency,
  Obligation,
} from '../../src/model.ts';
import { replayProjection } from '../../src/projection.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const verifierRevision='file-content-equals/v1@semantics-1';

function work(
  id:string,
  path:string,
  content:string,
  dependencies:Dependency[]=[],
):Obligation {
  return {
    id,
    dependencies,
    packet:{purpose:id},
    postcondition:{
      verifier:'file-content-equals/v1',
      path,
      content,
    },
  };
}

const upstream=work('upstream','/provider/upstream','UPSTREAM');
const control=work(
  'control',
  '/provider/control',
  'CONTROL',
  [{kind:'control',upstream:'upstream'}],
);
const output=work(
  'output',
  '/provider/output',
  'OUTPUT',
  [{
    kind:'semantic',
    upstream:'upstream',
    consumes:{kind:'output',selector:'verified-content'},
  }],
);
const receiptConsumer=work(
  'receipt',
  '/provider/receipt',
  'RECEIPT',
  [{
    kind:'semantic',
    upstream:'upstream',
    consumes:{kind:'evidence',selector:'settlement-receipt'},
  }],
);
const obligations=[upstream,control,output,receiptConsumer];

function definitionRecord(
  obligation:Obligation,
  commit:string,
  parent:string|null,
):FactCommit {
  const fact:ObligationFact={
    schema:OBLIGATION_SCHEMA,
    kind:'defined',
    obligation,
  };
  return {commit,parent,obligation:fact};
}

const definitions:FactCommit[]=[
  definitionRecord(upstream,'define-upstream',null),
  definitionRecord(control,'define-control','define-upstream'),
  definitionRecord(output,'define-output','define-control'),
  definitionRecord(receiptConsumer,'define-receipt','define-output'),
];

function currentHead(records:FactCommit[]):string {
  const head=records.at(-1)?.commit;
  assert.ok(head);
  return head;
}

function exactTsKey(records:FactCommit[],obligation:Obligation):string {
  const projection=replayProjection(records);
  const key=obligationKey(
    projection.state,
    obligation,
    projection.history.lifecycles,
    projection.history.receiptsByRun,
  );
  assert.ok(key);
  return key;
}

function upstreamDoneHistory():FactCommit[] {
  const key=exactTsKey(definitions,upstream);
  const claim:FactCommit={
    commit:'claim-upstream',
    parent:'define-receipt',
    claim:{
      schema:CLAIM_SCHEMA,
      run_id:'run-upstream',
      obligation_id:'upstream',
      claimed_revision:'define-receipt',
      obligation_key:key,
      execution_capability_sha256:sha256('cap-upstream'),
    },
  };
  const receipt:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-upstream',
    obligation_id:'upstream',
    claimed_revision:'define-receipt',
    claim_commit:'claim-upstream',
    execution_generation:1,
    execution_authority_commit:'claim-upstream',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/upstream',
      expected_sha256:sha256('UPSTREAM'),
      actual_sha256:sha256('UPSTREAM'),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-19T00:00:00.000Z',
  };
  return [
    ...definitions,
    claim,
    {commit:'receipt-upstream',parent:'claim-upstream',receipt},
  ];
}

function leanPostcondition(obligation:Obligation) {
  assert.equal(obligation.postcondition.verifier,'file-content-equals/v1');
  if(obligation.postcondition.verifier!=='file-content-equals/v1') {
    throw new Error('unsupported fixture');
  }
  return {
    family:'file-content',
    verifier_revision:verifierRevision,
    coordinate:obligation.postcondition.path,
    expected:sha256(obligation.postcondition.content),
  };
}

function leanObligation(obligation:Obligation) {
  return {
    id:obligation.id,
    packet_identity:canonicalDigest(obligation.packet),
    postcondition:leanPostcondition(obligation),
    dependencies:obligation.dependencies.map(dependency=>
      dependency.kind==='control'
        ? {kind:'control',upstream:dependency.upstream}
        : {
            kind:'semantic',
            upstream:dependency.upstream,
            selector:dependency.consumes.selector,
          }),
  };
}

function upstreamLeanKey() {
  return {
    id:'upstream',
    packet_identity:canonicalDigest(upstream.packet),
    postcondition:leanPostcondition(upstream),
    semantic_inputs:[],
  };
}

function leanKey(
  obligation:Obligation,
  settlementCommit='receipt-upstream',
) {
  const semanticInputs=obligation.dependencies.flatMap(dependency=>{
    if(dependency.kind!=='semantic') return [];
    if(dependency.consumes.selector==='verified-content') {
      return [{
        selector:'verified-content',
        identity:{
          family:'file-content',
          coordinate:'/provider/upstream',
          expected:sha256('UPSTREAM'),
        },
      }];
    }
    if(dependency.consumes.selector==='settlement-receipt') {
      return [{
        selector:'settlement-receipt',
        identity:{commit:settlementCommit},
      }];
    }
    throw new Error('unsupported semantic fixture');
  });
  return {
    id:obligation.id,
    packet_identity:canonicalDigest(obligation.packet),
    postcondition:leanPostcondition(obligation),
    semantic_inputs:semanticInputs,
  };
}

function leanRuns(done:boolean) {
  return done
    ? [{
        run_id:'run-upstream',
        obligation_id:'upstream',
        key:upstreamLeanKey(),
        disposition:'DONE',
        settlement_commit:'receipt-upstream',
      }]
    : [];
}

function leanAdmission(input:{
  history:FactCommit[];
  obligation:Obligation;
  runId?:string;
  parentRevision?:string;
  claimedRevision?:string;
  key?:ReturnType<typeof leanKey>;
  capabilityDigest?:string;
  done?:boolean;
  fresh?:'exact'|'none'|'drifted'|'duplicate';
}):{accepted:boolean;reason:string|null} {
  const head=currentHead(input.history);
  const candidate={
    run_id:input.runId??`run-${input.obligation.id}`,
    obligation_id:input.obligation.id,
    parent_revision:input.parentRevision??head,
    claimed_revision:input.claimedRevision??head,
    obligation_key:input.key??leanKey(input.obligation),
    capability_digest:input.capabilityDigest??sha256(`cap-${input.obligation.id}`),
  };
  const exactFresh={
    obligation_id:'upstream',
    observation:{
      family:'file-content',
      verifier_revision:verifierRevision,
      coordinate:'/provider/upstream',
      certainty:'present',
      actual:sha256('UPSTREAM'),
      absence:null,
    },
  };
  const driftedFresh={
    ...exactFresh,
    observation:{
      ...exactFresh.observation,
      actual:sha256('DRIFTED'),
    },
  };
  const freshMode=input.fresh??((input.done??false)?'exact':'none');
  const freshObservations=freshMode==='exact'
    ? [exactFresh]
    : freshMode==='drifted'
      ? [driftedFresh]
      : freshMode==='duplicate'
        ? [exactFresh,exactFresh]
        : [];

  return JSON.parse(execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'claim-admission',
      current_revision:head,
      obligations:obligations.map(leanObligation),
      runs:leanRuns(input.done??false),
      fresh_observations:freshObservations,
      candidate,
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  }));
}

function tsAdmission(input:{
  history:FactCommit[];
  obligation:Obligation;
  runId?:string;
  parentRevision?:string;
  claimedRevision?:string;
  key?:string;
  capabilityDigest?:string;
}):boolean {
  const head=currentHead(input.history);
  const claim:FactCommit={
    commit:`claim-${input.obligation.id}-candidate`,
    parent:input.parentRevision??head,
    claim:{
      schema:CLAIM_SCHEMA,
      run_id:input.runId??`run-${input.obligation.id}`,
      obligation_id:input.obligation.id,
      claimed_revision:input.claimedRevision??head,
      obligation_key:input.key??exactTsKey(input.history,input.obligation),
      execution_capability_sha256:input.capabilityDigest??sha256(`cap-${input.obligation.id}`),
    },
  };
  try {
    replayProjection([...input.history,claim]);
    return true;
  } catch {
    return false;
  }
}


function leanGraphValid(graph:Obligation[]):boolean {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'claim-graph',
      obligations:graph.map(leanObligation),
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return (JSON.parse(stdout) as {valid:boolean}).valid;
}

function tsGraphValid(graph:Obligation[]):boolean {
  const state:State={
    obligations:Object.fromEntries(graph.map(obligation=>[
      obligation.id,
      structuredClone(obligation),
    ])),
    definition_commits:Object.fromEntries(graph.map((obligation,index)=>[
      obligation.id,
      `definition-${index}`,
    ])),
  };
  try {
    validateGraph(state);
    return true;
  } catch {
    return false;
  }
}

test('Lean graph topology validation agrees with TypeScript on hostile graphs',()=>{
  assert.equal(leanGraphValid(obligations),true);
  assert.equal(tsGraphValid(obligations),true);

  const dangling:Obligation={
    ...structuredClone(control),
    id:'dangling',
    dependencies:[{kind:'control',upstream:'missing'}],
  };
  assert.equal(leanGraphValid([dangling]),false);
  assert.equal(tsGraphValid([dangling]),false);

  const cycleA=work(
    'cycle-a',
    '/provider/cycle-a',
    'A',
    [{kind:'control',upstream:'cycle-b'}],
  );
  const cycleB=work(
    'cycle-b',
    '/provider/cycle-b',
    'B',
    [{
      kind:'semantic',
      upstream:'cycle-a',
      consumes:{kind:'output',selector:'verified-content'},
    }],
  );
  assert.equal(leanGraphValid([cycleA,cycleB]),false);
  assert.equal(tsGraphValid([cycleA,cycleB]),false);

  const duplicate=[upstream,{...structuredClone(upstream),packet:{duplicate:true}}];
  assert.equal(leanGraphValid(duplicate),false);

  const first=definitionRecord(duplicate[0],'duplicate-1',null);
  const second=definitionRecord(duplicate[1],'duplicate-2','duplicate-1');
  assert.throws(()=>replayProjection([first,second]),/DUPLICATE_OBLIGATION/);
});

test('Lean claim admission agrees with TypeScript replay on valid-chain hostile cases',()=>{
  const done=upstreamDoneHistory();
  const cases:Array<{
    name:string;
    history:FactCommit[];
    obligation:Obligation;
    done:boolean;
    runId?:string;
    parentRevision?:string;
    claimedRevision?:string;
    leanKeyOverride?:ReturnType<typeof leanKey>;
    tsKeyOverride?:string;
    capabilityDigest?:string;
    expected:boolean;
  }>=[
    {
      name:'independent obligation accepted',
      history:definitions,
      obligation:upstream,
      done:false,
      expected:true,
    },
    {
      name:'control dependency unsatisfied',
      history:definitions,
      obligation:control,
      done:false,
      expected:false,
    },
    {
      name:'control dependency done',
      history:done,
      obligation:control,
      done:true,
      expected:true,
    },
    {
      name:'semantic output dependency done',
      history:done,
      obligation:output,
      done:true,
      expected:true,
    },
    {
      name:'settlement receipt dependency done',
      history:done,
      obligation:receiptConsumer,
      done:true,
      expected:true,
    },
    {
      name:'stale claimed revision',
      history:done,
      obligation:control,
      done:true,
      claimedRevision:'stale',
      expected:false,
    },
    {
      name:'fact parent differs from claimed revision',
      history:done,
      obligation:control,
      done:true,
      parentRevision:'stale-parent',
      expected:false,
    },
    {
      name:'obligation key mismatch',
      history:done,
      obligation:control,
      done:true,
      leanKeyOverride:upstreamLeanKey(),
      tsKeyOverride:'0'.repeat(64),
      expected:false,
    },
    {
      name:'duplicate run id',
      history:done,
      obligation:control,
      done:true,
      runId:'run-upstream',
      expected:false,
    },
    {
      name:'already realized obligation',
      history:done,
      obligation:upstream,
      done:true,
      expected:false,
    },
    {
      name:'invalid capability digest',
      history:done,
      obligation:control,
      done:true,
      capabilityDigest:'not-a-digest',
      expected:false,
    },
  ];

  for(const candidate of cases) {
    const ts=tsAdmission({
      history:candidate.history,
      obligation:candidate.obligation,
      runId:candidate.runId,
      parentRevision:candidate.parentRevision,
      claimedRevision:candidate.claimedRevision,
      key:candidate.tsKeyOverride,
      capabilityDigest:candidate.capabilityDigest,
    });
    const lean=leanAdmission({
      history:candidate.history,
      obligation:candidate.obligation,
      done:candidate.done,
      runId:candidate.runId,
      parentRevision:candidate.parentRevision,
      claimedRevision:candidate.claimedRevision,
      key:candidate.leanKeyOverride,
      capabilityDigest:candidate.capabilityDigest,
    });
    assert.equal(ts,candidate.expected,`${candidate.name}: TypeScript`);
    assert.equal(lean.accepted,candidate.expected,`${candidate.name}: Lean`);
  }
});


test('mutable historical DONE requires fresh verification at claim admission',()=>{
  const history=upstreamDoneHistory();

  assert.equal(tsAdmission({
    history,
    obligation:control,
  }),true);

  const missing=leanAdmission({
    history,
    obligation:control,
    done:true,
    fresh:'none',
  });
  assert.equal(missing.accepted,false);
  assert.equal(missing.reason,'UNSATISFIED_DEPENDENCIES');

  const drifted=leanAdmission({
    history,
    obligation:control,
    done:true,
    fresh:'drifted',
  });
  assert.equal(drifted.accepted,false);
  assert.equal(drifted.reason,'UNSATISFIED_DEPENDENCIES');

  const ambiguous=leanAdmission({
    history,
    obligation:control,
    done:true,
    fresh:'duplicate',
  });
  assert.equal(ambiguous.accepted,false);
  assert.equal(ambiguous.reason,'UNSATISFIED_DEPENDENCIES');

  const exact=leanAdmission({
    history,
    obligation:control,
    done:true,
    fresh:'exact',
  });
  assert.equal(exact.accepted,true);
});

test('Lean makes the TypeScript projector ancestry precondition explicit',()=>{
  const history=upstreamDoneHistory();
  const current=currentHead(history);
  const ts=tsAdmission({
    history,
    obligation:control,
    parentRevision:'detached-revision',
    claimedRevision:'detached-revision',
  });
  assert.equal(
    ts,
    true,
    'pure TypeScript replay assumes FactCommit[] already follows authoritative ancestry',
  );

  const lean=leanAdmission({
    history,
    obligation:control,
    done:true,
    parentRevision:'detached-revision',
    claimedRevision:'detached-revision',
  });
  assert.equal(lean.accepted,false);
  assert.equal(lean.reason,'REVISION_MISMATCH');
  assert.equal(current,'receipt-upstream');
});
