import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  CLAIM_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
} from '../../src/facts.ts';
import type {
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  ObligationFact,
  ReceiptFact,
} from '../../src/facts.ts';
import { obligationKey } from '../../src/lifecycle.ts';
import type { Obligation } from '../../src/model.ts';
import { replayProjection } from '../../src/projection.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

const obligation:Obligation={
  id:'work',
  dependencies:[],
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/work',
    content:'A',
  },
};

const definition:ObligationFact={
  schema:OBLIGATION_SCHEMA,
  kind:'defined',
  obligation,
};

const defineRecord:FactCommit={
  commit:'revision-a',
  parent:null,
  obligation:definition,
};

const baseProjection=replayProjection([defineRecord]);
const key=obligationKey(
  baseProjection.state,
  obligation,
  baseProjection.history.lifecycles,
  baseProjection.history.receiptsByRun,
);
assert.ok(key);

const claimRecord:FactCommit={
  commit:'claim-a',
  parent:'revision-a',
  claim:{
    schema:CLAIM_SCHEMA,
    run_id:'run-1',
    obligation_id:'work',
    claimed_revision:'revision-a',
    obligation_key:key,
    execution_capability_sha256:digest('capability-1'),
  },
};

type LeanFact=Record<string,unknown>;

const seed={
  run_id:'run-1',
  obligation_id:'work',
  claimed_revision:'revision-a',
  claim_commit:'claim-a',
  generation:1,
  authority_commit:'claim-a',
  capability_digest:digest('capability-1'),
  status:'EXECUTING',
  unresolved_effect:false,
};

function authority(
  commit='authority-2',
  {
    runId='run-1',
    obligationId='work',
    generation=2,
    previous='claim-a',
  }:{
    runId?:string;
    obligationId?:string;
    generation?:number;
    previous?:string;
  }={},
):{record:FactCommit;lean:LeanFact} {
  const fact:ExecutionAuthorityFact={
    schema:EXECUTION_AUTHORITY_SCHEMA,
    run_id:runId,
    obligation_id:obligationId,
    generation,
    previous_authority_commit:previous,
    execution_capability_sha256:digest(`capability-${generation}`),
  };
  return {
    record:{commit,parent:'claim-a',execution_authority:fact},
    lean:{
      kind:'rotate-authority',
      commit,
      run_id:runId,
      obligation_id:obligationId,
      generation,
      previous_authority_commit:previous,
      capability_digest:fact.execution_capability_sha256,
    },
  };
}

function reservation(
  commit='reservation-2',
  {
    generation=2,
    authorityCommit='authority-2',
  }:{
    generation?:number;
    authorityCommit?:string;
  }={},
):{record:FactCommit;lean:LeanFact} {
  const fact:EffectReservationFact={
    schema:EFFECT_RESERVATION_SCHEMA,
    run_id:'run-1',
    obligation_id:'work',
    execution_generation:generation,
    execution_authority_commit:authorityCommit,
  };
  return {
    record:{commit,parent:authorityCommit,effect_reservation:fact},
    lean:{
      kind:'reserve-effect',
      commit,
      run_id:'run-1',
      obligation_id:'work',
      generation,
      authority_commit:authorityCommit,
    },
  };
}

function receipt(
  commit:string,
  {
    kind,
    disposition,
    generation=2,
    authorityCommit='authority-2',
    claimedRevision='revision-a',
    claimCommit='claim-a',
  }:{
    kind:'observation'|'judgment-required'|'execution-terminated';
    disposition?:'DONE'|'READY'|'RECOVERY_REQUIRED';
    generation?:number;
    authorityCommit?:string;
    claimedRevision?:string;
    claimCommit?:string;
  },
):{record:FactCommit;lean:LeanFact} {
  const observed=kind==='observation'
    ? disposition==='DONE'
      ? {
          verifier:'file-content-equals/v1' as const,
          path:'/provider/work',
          expected_sha256:digest('A'),
          actual_sha256:digest('A'),
          mutation_certainty:'present' as const,
        }
      : {
          verifier:'file-content-equals/v1' as const,
          path:'/provider/work',
          expected_sha256:digest('A'),
          actual_sha256:digest('B'),
          mutation_certainty:'uncertain' as const,
        }
    : null;

  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-1',
    obligation_id:'work',
    claimed_revision:claimedRevision,
    claim_commit:claimCommit,
    execution_generation:generation,
    execution_authority_commit:authorityCommit,
    kind,
    observed,
    settled_at:'2026-09-19T00:00:00.000Z',
  };

  return {
    record:{commit,parent:authorityCommit,receipt:fact},
    lean:{
      kind:'receipt',
      commit,
      run_id:'run-1',
      obligation_id:'work',
      claimed_revision:claimedRevision,
      claim_commit:claimCommit,
      generation,
      authority_commit:authorityCommit,
      receipt_kind:kind,
      ...(kind==='observation'?{disposition}:{}),
    },
  };
}

function leanReplay(facts:LeanFact[]):{
  accepted:boolean;
  generation?:string;
  authority_commit?:string;
  status?:string;
  unresolved_effect?:boolean;
} {
  return JSON.parse(execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'execution-replay',
      seed,
      facts,
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  }));
}

function tsReplay(records:FactCommit[]):{
  accepted:boolean;
  generation?:number;
  authorityCommit?:string;
  status?:string;
  unresolvedEffect?:boolean;
} {
  try {
    const projection=replayProjection([
      defineRecord,
      claimRecord,
      ...records,
    ]);
    const run=projection.history.runs.get('run-1');
    assert.ok(run);
    return {
      accepted:true,
      generation:run.execution_generation,
      authorityCommit:run.execution_authority_commit,
      status:projection.history.lifecycles.get('work')?.status,
      unresolvedEffect:projection.history.unresolvedReservationsByRun.has('run-1'),
    };
  } catch {
    return {accepted:false};
  }
}

test('Lean execution reducer agrees with TypeScript replay fencing on hostile sequences',()=>{
  const a2=authority();
  const reserve2=reservation();

  const cases:Array<{
    name:string;
    ts:FactCommit[];
    lean:LeanFact[];
  }>=[
    {
      name:'rotate authority',
      ts:[a2.record],
      lean:[a2.lean],
    },
    {
      name:'skip generation',
      ts:[authority('authority-3',{generation:3}).record],
      lean:[authority('authority-3',{generation:3}).lean],
    },
    {
      name:'stale predecessor authority',
      ts:[authority('authority-2',{previous:'stale'}).record],
      lean:[authority('authority-2',{previous:'stale'}).lean],
    },
    {
      name:'reserve exact generation',
      ts:[a2.record,reserve2.record],
      lean:[a2.lean,reserve2.lean],
    },
    {
      name:'stale reservation generation',
      ts:[a2.record,reservation('reservation-stale',{generation:1,authorityCommit:'claim-a'}).record],
      lean:[a2.lean,reservation('reservation-stale',{generation:1,authorityCommit:'claim-a'}).lean],
    },
    {
      name:'stale reservation authority',
      ts:[a2.record,reservation('reservation-stale',{generation:2,authorityCommit:'claim-a'}).record],
      lean:[a2.lean,reservation('reservation-stale',{generation:2,authorityCommit:'claim-a'}).lean],
    },
    {
      name:'duplicate unresolved reservation',
      ts:[a2.record,reserve2.record,{...reserve2.record,commit:'reservation-duplicate'}],
      lean:[a2.lean,reserve2.lean,{...reserve2.lean,commit:'reservation-duplicate'}],
    },
    {
      name:'judgment after reservation',
      ts:[
        a2.record,
        reserve2.record,
        receipt('judgment',{kind:'judgment-required'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('judgment',{kind:'judgment-required'}).lean,
      ],
    },
    {
      name:'termination preserves unresolved effect',
      ts:[
        a2.record,
        reserve2.record,
        receipt('terminated',{kind:'execution-terminated'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('terminated',{kind:'execution-terminated'}).lean,
      ],
    },
    {
      name:'successful observation settles',
      ts:[
        a2.record,
        reserve2.record,
        receipt('done',{kind:'observation',disposition:'DONE'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('done',{kind:'observation',disposition:'DONE'}).lean,
      ],
    },
    {
      name:'stale receipt generation',
      ts:[
        a2.record,
        reserve2.record,
        receipt('stale',{kind:'observation',disposition:'DONE',generation:1,authorityCommit:'claim-a'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('stale',{kind:'observation',disposition:'DONE',generation:1,authorityCommit:'claim-a'}).lean,
      ],
    },
    {
      name:'stale receipt authority',
      ts:[
        a2.record,
        reserve2.record,
        receipt('stale',{kind:'observation',disposition:'DONE',authorityCommit:'claim-a'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('stale',{kind:'observation',disposition:'DONE',authorityCommit:'claim-a'}).lean,
      ],
    },
    {
      name:'stale receipt revision',
      ts:[
        a2.record,
        reserve2.record,
        receipt('stale',{kind:'observation',disposition:'DONE',claimedRevision:'revision-b'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('stale',{kind:'observation',disposition:'DONE',claimedRevision:'revision-b'}).lean,
      ],
    },
    {
      name:'stale receipt claim',
      ts:[
        a2.record,
        reserve2.record,
        receipt('stale',{kind:'observation',disposition:'DONE',claimCommit:'other-claim'}).record,
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('stale',{kind:'observation',disposition:'DONE',claimCommit:'other-claim'}).lean,
      ],
    },
    {
      name:'authority after terminal DONE',
      ts:[
        a2.record,
        reserve2.record,
        receipt('done',{kind:'observation',disposition:'DONE'}).record,
        {
          ...authority('authority-3',{
            generation:3,
            previous:'authority-2',
          }).record,
          parent:'done',
        },
      ],
      lean:[
        a2.lean,
        reserve2.lean,
        receipt('done',{kind:'observation',disposition:'DONE'}).lean,
        authority('authority-3',{
          generation:3,
          previous:'authority-2',
        }).lean,
      ],
    },
  ];

  for(const candidate of cases) {
    const ts=tsReplay(candidate.ts);
    const lean=leanReplay(candidate.lean);

    assert.equal(lean.accepted,ts.accepted,`${candidate.name}: acceptance`);
    if(!ts.accepted) continue;

    assert.equal(Number(lean.generation),ts.generation,`${candidate.name}: generation`);
    assert.equal(lean.authority_commit,ts.authorityCommit,`${candidate.name}: authority`);
    assert.equal(lean.status,ts.status,`${candidate.name}: status`);
    assert.equal(lean.unresolved_effect,ts.unresolvedEffect,`${candidate.name}: reservation`);
  }
});
