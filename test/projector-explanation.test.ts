import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../src/authority/facts.ts';
import type { Obligation } from '../src/model.ts';
import {
  deriveProjectProjection,
  explainProjectWork,
} from '../src/authority/project-state.ts';

const a:Obligation={
  id:'a',
  dependencies:[],
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/a',
    content:'A',
  },
};
const b:Obligation={
  id:'b',
  dependencies:[{kind:'control',upstream:'a'}],
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/b',
    content:'B',
  },
};
const state:State={
  obligations:{a,b},
  definition_commits:{a:'define-a',b:'define-b'},
};

function runA(
  semanticKey:string,
):HistoricalRun {
  return {
    id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    obligation_key:semanticKey,
    execution_generation:2,
    execution_authority_commit:'authority-a',
    execution_capability_sha256:'0'.repeat(64),
    obligation:a,
    definition_commit:'define-a',
  };
}

function receipt(
  disposition:Receipt['disposition'],
  kind:Receipt['kind'],
):Receipt {
  return {
    schema:RECEIPT_SCHEMA,
    run_id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    execution_generation:2,
    execution_authority_commit:'authority-a',
    kind,
    observed:kind==='observation'
      ? {
          verifier:'file-content-equals/v1',
          path:'/provider/a',
          mutation_certainty:disposition==='DONE'?'present':'absent',
        }
      : null,
    settled_at:'2026-09-19T00:00:00.000Z',
    disposition,
    verified:disposition==='DONE',
    settlement_commit:`receipt-${disposition.toLowerCase()}`,
  };
}

function keyForA():string {
  const base=deriveProjectProjection({
    state,
    runs:new Map(),
    receiptsByRun:new Map(),
    revision:'base',
  });
  const key=base.semanticKeys.get('a');
  assert.ok(key);
  return key;
}

test('BLOCKED explanation names unsatisfied dependency and its derived status',()=>{
  const project=deriveProjectProjection({
    state,
    runs:new Map(),
    receiptsByRun:new Map(),
    revision:'initial',
  });

  assert.deepEqual(explainProjectWork(project,'b'),{
    obligation_id:'b',
    status:'BLOCKED',
    reason:{
      kind:'unsatisfied-dependencies',
      dependencies:[{
        obligation_id:'a',
        status:'READY',
      }],
    },
  });
});

test('EXECUTING explanation binds exact active run and semantic key',()=>{
  const key=keyForA();
  const run=runA(key);
  const project=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map(),
    revision:'executing',
  });

  assert.deepEqual(explainProjectWork(project,'a'),{
    obligation_id:'a',
    status:'EXECUTING',
    reason:{
      kind:'active-run',
      run_id:'run-a',
      semantic_key:key,
      execution_generation:2,
    },
  });
});

test('WAITING and RECOVERY_REQUIRED explain the receipt that caused them',()=>{
  const key=keyForA();
  const run=runA(key);

  for (const [disposition,kind,reasonKind] of [
    ['WAITING','judgment-required','waiting-receipt'],
    ['RECOVERY_REQUIRED','execution-terminated','recovery-receipt'],
  ] as const) {
    const projectedReceipt=receipt(disposition,kind);
    const project=deriveProjectProjection({
      state,
      runs:new Map([[run.id,run]]),
      receiptsByRun:new Map([[run.id,projectedReceipt]]),
      revision:disposition,
    });

    assert.deepEqual(explainProjectWork(project,'a'),{
      obligation_id:'a',
      status:disposition,
      reason:{
        kind:reasonKind,
        run_id:'run-a',
        receipt_kind:kind,
        settlement_commit:projectedReceipt.settlement_commit,
      },
    });
  }
});

test('DONE explanation distinguishes historical reuse from current admissibility judgment',()=>{
  const key=keyForA();
  const run=runA(key);
  const done=receipt('DONE','observation');

  const historical=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,done]]),
    revision:'done-historical',
  });
  assert.equal(
    (explainProjectWork(historical,'a').reason as {admissibility_basis:string})
      .admissibility_basis,
    'historical-settlement',
  );

  const current=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,done]]),
    revision:'done-current',
    currentRealizationJudgments:new Map([
      ['run-a',{
        state:'admissible' as const,
        reason:'CURRENT_POSTCONDITION_VERIFIED' as const,
      }],
    ]),
  });
  assert.equal(
    (explainProjectWork(current,'a').reason as {admissibility_basis:string})
      .admissibility_basis,
    'current-semantic-judgment',
  );
});

test('READY explanation preserves accepted-absence release provenance',()=>{
  const key=keyForA();
  const run=runA(key);
  const ready=receipt('READY','observation');
  const project=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,ready]]),
    revision:'ready-again',
  });

  const explanation=explainProjectWork(project,'a');
  assert.equal(explanation.status,'READY');
  assert.equal(explanation.reason.kind,'claimable');
  if (explanation.reason.kind!=='claimable') {
    assert.fail('expected claimable explanation');
  }
  assert.deepEqual(explanation.reason.released_by,{
    run_id:'run-a',
    disposition:'READY',
    settlement_commit:'receipt-ready',
  });
});

test('READY explanation names a historical DONE rejected by current semantics',()=>{
  const key=keyForA();
  const run=runA(key);
  const done=receipt('DONE','observation');
  const project=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,done]]),
    revision:'drifted',
    currentRealizationJudgments:new Map([
      ['run-a',{
        state:'rejected' as const,
        reason:'CURRENT_POSTCONDITION_NOT_VERIFIED' as const,
      }],
    ]),
  });

  const explanation=explainProjectWork(project,'a');
  assert.equal(explanation.status,'READY');
  assert.equal(explanation.reason.kind,'claimable');
  if (explanation.reason.kind!=='claimable') {
    assert.fail('expected claimable explanation');
  }
  assert.deepEqual(explanation.reason.rejected_realization,{
    run_id:'run-a',
    disposition:'DONE',
    reason:'not-currently-admissible',
    settlement_commit:'receipt-done',
  });
});

test('explanations are total only for projected obligations',()=>{
  const project=deriveProjectProjection({
    state,
    runs:new Map(),
    receiptsByRun:new Map(),
    revision:'initial',
  });
  assert.throws(
    ()=>explainProjectWork(project,'missing'),
    /UNKNOWN_OBLIGATION:missing/,
  );
});


test('static effect-conflict provenance preserves obligation IDs containing colons',()=>{
  const left:Obligation={
    id:'left:status',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:1,
      repository_full_name:'example/repo',
      commit_sha:'a'.repeat(40),
      context:'overcenter/test',
      expected_state:'success',
    },
  };
  const right:Obligation={
    id:'right:status',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:1,
      repository_full_name:'example/repo',
      commit_sha:'a'.repeat(40),
      context:'overcenter/test',
      expected_state:'failure',
    },
  };
  const conflicting:State={
    obligations:{
      [left.id]:left,
      [right.id]:right,
    },
    definition_commits:{
      [left.id]:'define-left',
      [right.id]:'define-right',
    },
  };
  const project=deriveProjectProjection({
    state:conflicting,
    runs:new Map(),
    receiptsByRun:new Map(),
    revision:'legacy-conflict',
  });

  const explanation=explainProjectWork(project,left.id);
  assert.equal(explanation.status,'BLOCKED');
  assert.equal(explanation.reason.kind,'static-effect-conflict');
  if (explanation.reason.kind!=='static-effect-conflict') {
    assert.fail('expected static-effect-conflict explanation');
  }
  assert.deepEqual(
    explanation.reason.conflicting_obligations,
    ['left:status','right:status'],
  );
});


test('BLOCKED explanation names indeterminate current realization evidence',()=>{
  const key=keyForA();
  const run=runA(key);
  const done=receipt('DONE','observation');
  const project=deriveProjectProjection({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,done]]),
    revision:'indeterminate-current-read',
    currentRealizationJudgments:new Map([
      ['run-a',{
        state:'indeterminate',
        reason:'CURRENT_REALIZATION_OBSERVATION_INDETERMINATE',
      }],
    ]),
  });

  assert.deepEqual(explainProjectWork(project,'a'),{
    obligation_id:'a',
    status:'BLOCKED',
    reason:{
      kind:'current-realization-indeterminate',
      run_id:'run-a',
      reason:'CURRENT_REALIZATION_OBSERVATION_INDETERMINATE',
      settlement_commit:'receipt-done',
    },
  });
});
