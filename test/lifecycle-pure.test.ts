import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { RunRecord, ObligationCatalog, Receipt } from '../src/facts.ts';
import { deriveLifecycles, obligationKey } from '../src/lifecycle.ts';
import { claimabilityError, projectWork } from '../src/eligibility.ts';

const work:Obligation={
  id:'a',
  dependencies:[],
  packet:{},
  postcondition:{verifier:'file-content-equals/v1',path:'/provider/a',content:'A'},
};
const state:ObligationCatalog={obligations:{a:work},definition_commits:{a:'define-a'}};

test('unrealized lifecycle becomes public READY only after eligibility',()=>{
  const lifecycles=deriveLifecycles(state,new Map(),new Map());
  assert.equal(lifecycles.get('a')?.status,'UNREALIZED');
  assert.equal(claimabilityError(state,work,lifecycles),null);
  assert.equal(projectWork(state,work,'revision-a',lifecycles).status,'READY');
});

test('a valid historical realization remains DONE, not READY',()=>{
  const receipts=new Map<string,Receipt>();
  const base=deriveLifecycles(state,new Map<string,RunRecord>(),receipts);
  const key=obligationKey(state,work,base,receipts);
  assert.ok(key);
  const run:RunRecord={
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
  const lifecycles=deriveLifecycles(
    state,new Map([['run-a',run]]),new Map([['run-a',receipt]]),
  );
  assert.equal(lifecycles.get('a')?.status,'DONE');
  assert.equal(projectWork(state,work,'revision-b',lifecycles).status,'DONE');
});
