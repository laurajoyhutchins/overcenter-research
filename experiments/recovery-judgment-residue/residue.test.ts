import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

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


test('trusted search runner is the only bridge from model parameters to certainty',()=>{
  assert.equal(typeof (gate as any).runJudgmentSearch,'function');

  const candidate={
    query:'operation=iam.serviceAccounts.create principal=serviceAccount:canary-deployer label=violet-sunrise',
    reason:'The incident describes the canary deploy identity and retained request label.',
  };

  const noHit=(gate as any).runJudgmentSearch(
    judgmentCase,
    judgmentState(),
    candidate,
    ()=>({
      authority:'authoritative',
      certainty:'uncertain',
      evidence_id:'audit-search:no-hit',
    }),
  );
  assert.equal(noHit.status,'JUDGMENT_REQUIRED');
  assert.equal(noHit.certainty,'uncertain');

  const exact=(gate as any).runJudgmentSearch(
    judgmentCase,
    judgmentState(),
    candidate,
    ()=>({
      authority:'authoritative',
      certainty:'present',
      evidence_id:'audit:event-8841',
    }),
  );
  assert.equal(exact.status,'RESOLVED');
  assert.equal(exact.certainty,'present');
});


const lockedFixture=JSON.parse(
  readFileSync(new URL('./fixture.json',import.meta.url),'utf8'),
);

test('model-visible assignment cannot contain the hidden oracle',async()=>{
  const residue=await import('./residue.ts').catch(()=>({} as any));
  assert.equal(typeof (residue as any).publicAssignment,'function');

  const assignment=(residue as any).publicAssignment(lockedFixture);
  const visible=JSON.stringify(assignment);
  assert.match(visible,/violet-sunrise/);
  assert.doesNotMatch(visible,/audit:event-8841/);
  assert.doesNotMatch(visible,/sha256:canary-deploy-identity/);
  assert.doesNotMatch(visible,/"truth"/);
  assert.doesNotMatch(visible,/"records"/);
});

test('locked authoritative search resolves only the exact effect-bound record',async()=>{
  const residue=await import('./residue.ts').catch(()=>({} as any));
  assert.equal(typeof (residue as any).evaluateCandidate,'function');

  const good=(residue as any).evaluateCandidate(lockedFixture,{
    query:'operation=iam.serviceAccounts.create principal=serviceAccount:canary-deployer label=violet-sunrise',
    reason:'The incident describes creation of the canary deploy identity and retains its request label.',
  });
  assert.equal(good.status,'RESOLVED');
  assert.equal(good.certainty,'present');
  assert.equal(good.false_certainty,0);

  const ambiguous=(residue as any).evaluateCandidate(lockedFixture,{
    query:'operation=iam.serviceAccounts.create label=violet-sunrise',
    reason:'Search by the retained operation family and label.',
  });
  assert.equal(ambiguous.status,'JUDGMENT_REQUIRED');
  assert.equal(ambiguous.certainty,'uncertain');

  const wrongUnique=(residue as any).evaluateCandidate(lockedFixture,{
    query:'principal=serviceAccount:shadow-deployer label=amber-moon',
    reason:'A syntactically valid but wrong unique audit record.',
  });
  assert.equal(wrongUnique.status,'JUDGMENT_REQUIRED');
  assert.equal(wrongUnique.certainty,'uncertain');
  assert.equal(wrongUnique.false_certainty,0);

  const noHit=(residue as any).evaluateCandidate(lockedFixture,{
    query:'principal=serviceAccount:missing-deployer',
    reason:'A syntactically valid search with no authoritative match.',
  });
  assert.equal(noHit.status,'JUDGMENT_REQUIRED');
  assert.equal(noHit.certainty,'uncertain');
});
