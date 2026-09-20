import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { GitKernelFixture } from '../../test/support/git-kernel-fixture.ts';

test('eventually consistent negative readback cannot authorize replay after an uncertain effect',()=>{
  const f=new GitKernelFixture('overcenter-eventual-readback-');
  const providerTruth=f.path('provider-authoritative-write-log.json');

  try {
    f.defineFile('hostile-effect',{
      content:'created',
      consistency:'eventual',
      packet:{effect:'create-resource',key:'resource-42',value:'created'},
    });

    const run=f.claim('hostile-effect');
    let effectAttempts=0;

    f.kernel.beginEffect(run);
    effectAttempts+=1;
    writeFileSync(providerTruth,JSON.stringify({
      key:'resource-42',
      value:'created',
      accepted:true,
    }));
    f.kernel.recordExecutionTerminated(run,{source:'hostile-provider-timeout'});

    const missing=f.kernel.reconcile(run);
    assert.equal(missing.disposition,'RECOVERY_REQUIRED');
    assert.equal(missing.observed?.mutation_certainty,'uncertain');
    assert.equal(missing.observed?.absence_evidence,undefined);
    assert.equal(missing.observed?.observation_error,'NEGATIVE_READ_NOT_AUTHORITATIVE');
    assert.equal(f.kernel.nextReadyWork(),null);

    writeFileSync(f.path('hostile-effect'),'old-value');
    const stale=f.kernel.reconcile(run);
    assert.equal(stale.disposition,'RECOVERY_REQUIRED');
    assert.equal(stale.observed?.mutation_certainty,'uncertain');
    assert.equal(stale.observed?.absence_evidence,undefined);
    assert.equal(stale.observed?.observation_error,'NON_MATCHING_READ_NOT_AUTHORITATIVE');
    assert.equal(f.kernel.nextReadyWork(),null);

    writeFileSync(f.path('hostile-effect'),'created');
    const done=f.kernel.reconcile(run);
    assert.equal(done.disposition,'DONE');
    assert.equal(done.verified,true);
    assert.equal(done.observed?.mutation_certainty,'present');
    assert.equal(f.work('hostile-effect').status,'DONE');

    assert.equal(effectAttempts,1);
    assert.equal(JSON.parse(readFileSync(providerTruth,'utf8')).accepted,true);
    assert.equal(done.claim_commit,run.claim_commit);
    assert.deepEqual(
      f.kernel.receipts(run.id).map(receipt=>receipt.disposition),
      ['RECOVERY_REQUIRED','RECOVERY_REQUIRED','RECOVERY_REQUIRED','DONE'],
    );
  } finally {
    f.close();
  }
});
