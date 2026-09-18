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
import { claimabilityError } from '../src/eligibility.ts';
import { projectReceipt, replayProjection } from '../src/projection.ts';
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
  const base=replayProjection([
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
  const ready=replayProjection([defineRecord]);
  assert.equal(ready.history.lifecycles.get('a')?.status,'UNREALIZED');

  const claimRecord=claimCommit('define-1');
  const executing=replayProjection([defineRecord,claimRecord]);
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
  const done=replayProjection([
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
    ()=>replayProjection([defineRecord,claimRecord]),
    /CLAIM_REVISION_MISMATCH/,
  );
});

function absentReceipt(
  work:Obligation,
  authoritative:boolean,
  pathOverride?:string,
):ReceiptFact {
  const observed=work.postcondition.verifier==='github-commit-status/v1'
    ? {
        verifier:work.postcondition.verifier,
        provider:'github' as const,
        repository_id:work.postcondition.repository_id,
        commit_sha:work.postcondition.commit_sha,
        context:work.postcondition.context,
        mutation_certainty:'absent' as const,
        negative_evidence_authoritative:authoritative,
      }
    : {
        verifier:work.postcondition.verifier,
        path:pathOverride??work.postcondition.path,
        mutation_certainty:'absent' as const,
        negative_evidence_authoritative:authoritative,
      };
  return {
    schema:RECEIPT_SCHEMA,
    run_id:'run-absence',
    obligation_id:'absence',
    claimed_revision:'revision-absence',
    claim_commit:'claim-absence',
    kind:'observation',
    observed,
    settled_at:'2026-09-18T00:00:00.000Z',
  };
}

test('absence authorizes replay only when the verifier declared authoritative absence',()=>{
  const local:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{verifier:'file-content-equals/v1',path:'/provider/absence',content:'A'},
  };
  assert.equal(
    projectReceipt(absentReceipt(local,true),local).disposition,
    'READY',
  );
  assert.equal(
    projectReceipt(absentReceipt(local,false),local).disposition,
    'RECOVERY_REQUIRED',
  );
  assert.throws(
    ()=>projectReceipt(
      absentReceipt(local,true,'/provider/wrong-coordinate'),
      local,
    ),
    /OBSERVATION_COORDINATE_MISMATCH/,
  );

  const eventual:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'eventually-consistent-file-content-equals/v1',
      path:'/provider/absence',
      content:'A',
    },
  };
  assert.equal(
    projectReceipt(
      absentReceipt(eventual,true),
      eventual,
    ).disposition,
    'RECOVERY_REQUIRED',
  );

  const github:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/absence',
      expected_state:'success',
    },
  };
  assert.equal(
    projectReceipt(absentReceipt(github,true),github).disposition,
    'RECOVERY_REQUIRED',
  );
});

test('legacy v3 static-conflict history remains replayable but fail-closed',()=>{
  const status=(id:string,state:'success'|'failure'):Obligation=>({
    id,
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/legacy-conflict',
      expected_state:state,
    },
  });
  const alpha=status('alpha','success');
  const beta=status('beta','failure');
  const projection=replayProjection([
    {
      commit:'define-alpha',
      parent:null,
      obligation:{
        schema:OBLIGATION_SCHEMA,
        kind:'defined',
        obligation:alpha,
      },
    },
    {
      commit:'define-beta',
      parent:'define-alpha',
      obligation:{
        schema:OBLIGATION_SCHEMA,
        kind:'defined',
        obligation:beta,
      },
    },
  ]);

  assert.equal(projection.state.obligations.alpha.id,'alpha');
  assert.equal(projection.state.obligations.beta.id,'beta');
  assert.equal(
    claimabilityError(
      projection.state,
      alpha,
      projection.history.lifecycles,
    ),
    'UNORDERED_EFFECT_CONFLICT:alpha:beta',
  );
  assert.equal(
    claimabilityError(
      projection.state,
      beta,
      projection.history.lifecycles,
    ),
    'UNORDERED_EFFECT_CONFLICT:alpha:beta',
  );
});