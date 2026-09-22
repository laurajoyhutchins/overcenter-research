import assert from 'node:assert/strict';
import test from 'node:test';

import * as gate from '../recovery-reasoning/recovery-gate.ts';

const judgmentCase:gate.RecoveryCaseView={
  id:'unstructured-audit-query',
  recoverability:'judgment',
  actions:[],
  judgment:{
    reason:'Useful authoritative audit parameters require semantic synthesis from incident evidence.',
    future_tool:'search-authoritative-audit',
  },
};

function judgmentState():gate.RecoveryState {
  return gate.deterministicRecover(judgmentCase);
}

test('model candidate is parameter synthesis only',()=>{
  assert.equal(typeof (gate as any).validateJudgmentSearchCandidate,'function');

  const proposal=(gate as any).validateJudgmentSearchCandidate(
    judgmentCase,
    judgmentState(),
    {
      query:'operation=iam.serviceAccounts.create principal=deployer label=violet-sunrise',
      reason:'The incident describes creating a deploy identity and names the request label.',
    },
  );

  assert.deepEqual(proposal,{
    query:'operation=iam.serviceAccounts.create principal=deployer label=violet-sunrise',
    reason:'The incident describes creating a deploy identity and names the request label.',
  });
});

test('model candidate cannot smuggle certainty, effects, or a different tool',()=>{
  assert.equal(typeof (gate as any).validateJudgmentSearchCandidate,'function');

  for (const hostile of [
    {query:'q',reason:'r',certainty:'present'},
    {query:'q',reason:'r',kind:'retry-effect'},
    {query:'q',reason:'r',tool:'delete-provider-object'},
  ]) {
    assert.throws(
      ()=>(gate as any).validateJudgmentSearchCandidate(
        judgmentCase,
        judgmentState(),
        hostile,
      ),
      /JUDGMENT_SEARCH_CANDIDATE_INVALID/,
    );
  }
});

test('authoritative search evidence, not the model candidate, controls certainty',()=>{
  assert.equal(typeof (gate as any).admitRecoveryEvidence,'function');

  const state=judgmentState();
  const noHit=(gate as any).admitRecoveryEvidence(state,{
    authority:'authoritative',
    certainty:'uncertain',
    evidence_id:'audit-search:no-hit',
  });
  assert.equal(noHit.status,'JUDGMENT_REQUIRED');
  assert.equal(noHit.certainty,'uncertain');

  const resolved=(gate as any).admitRecoveryEvidence(noHit,{
    authority:'authoritative',
    certainty:'present',
    evidence_id:'audit:event-8841',
  });
  assert.equal(resolved.status,'RESOLVED');
  assert.equal(resolved.certainty,'present');

  assert.throws(
    ()=>(gate as any).admitRecoveryEvidence(state,{
      authority:'advisory',
      certainty:'present',
      evidence_id:'model:guess',
    }),
    /NON_AUTHORITATIVE_CERTAINTY_NOT_ADMISSIBLE/,
  );
});
