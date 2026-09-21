import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { HistoricalRun, Receipt, State } from '../src/facts.ts';
import { obligationKey } from '../src/semantic-identity.ts';
import { deriveProjectProjection } from '../src/projector.ts';

const work:Obligation={
  id:'a',
  dependencies:[],
  packet:{},
  postcondition:{verifier:'file-content-equals/v1',path:'/provider/a',content:'A'},
};
const state:State={obligations:{a:work},definition_ids:{a:'define-a'}};

test('unrealized lifecycle becomes public READY only through project projection',()=>{
  const project=deriveProjectProjection({
    state,
    runs:new Map(),
    receiptsByRun:new Map(),
    revision:'revision-a',
  });
  assert.equal(project.lifecycles.get('a')?.status,'UNREALIZED');
  assert.equal(project.claimabilityErrors.get('a'),null);
  assert.equal(project.work.find(candidate=>candidate.id==='a')?.status,'READY');
  assert.equal(project.readyWork?.id,'a');
});

test('a valid historical realization remains DONE, not READY',()=>{
  const receipts=new Map<string,Receipt>();
  const base=deriveProjectProjection({
    state,
    runs:new Map<string,HistoricalRun>(),
    receiptsByRun:receipts,
    revision:'revision-a',
  });
  const key=obligationKey(state,work,base.lifecycles,receipts);
  assert.ok(key);
  const run:HistoricalRun={
    id:'run-a',obligation_id:'a',claimed_revision:'revision-a',claim_commit:'claim-a',
    obligation_key:key,obligation:work,definition_commit:'define-a',
  };
  const receipt:Receipt={
    schema:'overcenter-git-receipt-v3',run_id:'run-a',obligation_id:'a',
    claimed_revision:'revision-a',claim_commit:'claim-a',kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',path:'/provider/a',
      expected_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty:'present',
    },
    settled_at:'2026-09-18T00:00:00.000Z',disposition:'DONE',verified:true,
    settlement_commit:'receipt-a',
  };
  const project=deriveProjectProjection({
    state,
    runs:new Map([['run-a',run]]),
    receiptsByRun:new Map([['run-a',receipt]]),
    revision:'revision-b',
  });
  assert.equal(project.lifecycles.get('a')?.status,'DONE');
  assert.equal(project.work.find(candidate=>candidate.id==='a')?.status,'DONE');
  assert.equal(project.readyWork,null);
});


test('current realization admissibility can withdraw historical DONE',()=>{
  const receipts=new Map<string,Receipt>();
  const base=deriveProjectProjection({
    state,
    runs:new Map<string,HistoricalRun>(),
    receiptsByRun:receipts,
    revision:'revision-a',
  });
  const key=obligationKey(state,work,base.lifecycles,receipts);
  assert.ok(key);

  const run:HistoricalRun={
    id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    obligation_key:key,
    obligation:work,
    definition_commit:'define-a',
  };
  const receipt:Receipt={
    schema:'overcenter-git-receipt-v3',
    run_id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty:'present',
    },
    settled_at:'2026-09-18T00:00:00.000Z',
    disposition:'DONE',
    verified:true,
    settlement_commit:'receipt-a',
  };

  const project=deriveProjectProjection({
    state,
    runs:new Map([['run-a',run]]),
    receiptsByRun:new Map([['run-a',receipt]]),
    revision:'revision-b',
    currentRealizationJudgments:new Map([
      ['run-a',{
        state:'rejected' as const,
        reason:'CURRENT_POSTCONDITION_NOT_VERIFIED' as const,
      }],
    ]),
  });

  assert.equal(project.lifecycles.get('a')?.status,'UNREALIZED');
  assert.equal(project.work.find(candidate=>candidate.id==='a')?.status,'READY');
  assert.equal(project.readyWork?.id,'a');
});


test('indeterminate current realization judgment blocks replay instead of becoming READY',()=>{
  const receipts=new Map<string,Receipt>();
  const base=deriveProjectProjection({
    state,
    runs:new Map<string,HistoricalRun>(),
    receiptsByRun:receipts,
    revision:'revision-a',
  });
  const key=obligationKey(state,work,base.lifecycles,receipts);
  assert.ok(key);
  const run:HistoricalRun={
    id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    obligation_key:key,
    execution_generation:1,
    execution_authority_commit:'claim-a',
    execution_capability_sha256:'0'.repeat(64),
    obligation:work,
    definition_commit:'define-a',
  };
  const receipt:Receipt={
    schema:'overcenter-git-receipt-v5',
    run_id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    execution_generation:1,
    execution_authority_commit:'claim-a',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty:'present',
    },
    settled_at:'2026-09-18T00:00:00.000Z',
    disposition:'DONE',
    verified:true,
    settlement_commit:'receipt-a',
  };
  const project=deriveProjectProjection({
    state,
    runs:new Map([['run-a',run]]),
    receiptsByRun:new Map([['run-a',receipt]]),
    revision:'revision-b',
    currentRealizationJudgments:new Map([
      ['run-a',{
        state:'indeterminate',
        reason:'CURRENT_REALIZATION_OBSERVATION_INDETERMINATE',
      }],
    ]),
  });

  assert.equal(project.lifecycles.get('a')?.status,'UNREALIZED');
  assert.equal(project.claimabilityErrors.get('a'),'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE');
  assert.equal(project.work.find(candidate=>candidate.id==='a')?.status,'BLOCKED');
  assert.equal(project.readyWork,null);
});
