import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CLAIM_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
} from '../src/facts.ts';
import type { FactCommit, ObligationFact, ReceiptFact } from '../src/facts.ts';
import { obligationKey } from '../src/lifecycle.ts';
import { reconstructProjection } from '../src/projection.ts';
import type { Obligation } from '../src/model.ts';

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

const obligation:Obligation={
  id:'a',
  dependencies:[],
  packet:{kind:'pure-projection-proof'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/a',
    content:'A',
  },
};

const defined:ObligationFact={
  schema:OBLIGATION_SCHEMA,
  kind:'defined',
  obligation,
};

function claimCommit(parent:string):FactCommit {
  const base=reconstructProjection([
    {commit:parent,parent:null,obligation:defined},
  ]);
  const key=obligationKey(
    base.state,
    obligation,
    base.history.lifecycles,
    base.history.receiptsByRun,
  );
  assert.ok(key);
  return {
    commit:'claim-1',
    parent,
    claim:{
      schema:CLAIM_SCHEMA,
      run_id:'run-1',
      obligation_id:'a',
      claimed_revision:parent,
      obligation_key:key,
    },
  };
}

test('pure replay derives UNREALIZED -> EXECUTING -> DONE without Git',()=>{
  const defineRecord:FactCommit={
    commit:'define-1',
    parent:null,
    obligation:defined,
  };
  const ready=reconstructProjection([defineRecord]);
  assert.equal(ready.history.lifecycles.get('a')?.status,'UNREALIZED');

  const claimRecord=claimCommit('define-1');
  const executing=reconstructProjection([defineRecord,claimRecord]);
  assert.equal(executing.history.lifecycles.get('a')?.status,'EXECUTING');

  const receipt:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-1',
    obligation_id:'a',
    claimed_revision:'define-1',
    claim_commit:'claim-1',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:sha256('A'),
      actual_sha256:sha256('A'),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-18T00:00:00.000Z',
  };
  const done=reconstructProjection([
    defineRecord,
    claimRecord,
    {commit:'receipt-1',parent:'claim-1',receipt},
  ]);

  assert.equal(done.history.lifecycles.get('a')?.status,'DONE');
  assert.equal(done.history.receipts.at(-1)?.verified,true);
  assert.equal(done.history.receipts.at(-1)?.settlement_commit,'receipt-1');
});

test('pure replay rejects a claim whose parent is not its claimed revision',()=>{
  const defineRecord:FactCommit={
    commit:'define-1',
    parent:null,
    obligation:defined,
  };
  const claimRecord=claimCommit('define-1');
  claimRecord.parent='different-head';

  assert.throws(
    ()=>reconstructProjection([defineRecord,claimRecord]),
    /CLAIM_REVISION_MISMATCH/,
  );
});
