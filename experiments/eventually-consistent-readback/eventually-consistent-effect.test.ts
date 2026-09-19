import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

test('eventually consistent negative readback cannot authorize replay after an uncertain effect', () => {
  const root=mkdtempSync(join(tmpdir(),'overcenter-eventual-readback-'));
  const authority=join(root,'authority.git');
  const providerTruth=join(root,'provider-authoritative-write-log.json');
  const readModel=join(root,'eventually-consistent-read-model.txt');

  try {
    execFileSync('git',['init','--bare',authority],{stdio:'ignore'});
    const kernel=new GitOvercenterKernel(authority);
    kernel.initialize();
    kernel.define({
      id:'hostile-effect',
      packet:{effect:'create-resource',key:'resource-42',value:'created'},
      postcondition:{
        verifier:'eventually-consistent-file-content-equals/v1',
        path:readModel,
        content:'created',
      },
    });

    const ready=kernel.nextReadyWork()!;
    const run=kernel.claim(ready.id,ready.revision);

    let effectAttempts=0;
    const performProviderEffect=() => {
      effectAttempts+=1;
      writeFileSync(providerTruth,JSON.stringify({
        key:'resource-42',
        value:'created',
        accepted:true,
      }));
    };

    // The trusted effect boundary reserves the coordinate before the provider
    // accepts the mutation. The caller then loses the outcome.
    kernel.beginEffect(run);
    performProviderEffect();
    kernel.recordExecutionTerminated(run,{source:'hostile-provider-timeout'});

    // First readback is a stale 404 / missing object. Because this provider's
    // read model is eventually consistent, that negative is not authoritative.
    const missing=kernel.reconcile(run);
    assert.equal(missing.disposition,'RECOVERY_REQUIRED');
    assert.equal(missing.observed?.mutation_certainty,'uncertain');
    assert.equal(missing.observed?.absence_evidence,undefined);
    assert.equal(missing.observed?.observation_error,'NEGATIVE_READ_NOT_AUTHORITATIVE');
    assert.equal(kernel.nextReadyWork(),null);
    assert.equal(kernel.inspect()[0].run_id,run.id);

    // Readback advances, but only to an older value. A non-match is still not
    // proof that the accepted mutation failed to happen.
    writeFileSync(readModel,'old-value');
    const stale=kernel.reconcile(run);
    assert.equal(stale.disposition,'RECOVERY_REQUIRED');
    assert.equal(stale.observed?.mutation_certainty,'uncertain');
    assert.equal(stale.observed?.absence_evidence,undefined);
    assert.equal(stale.observed?.observation_error,'NON_MATCHING_READ_NOT_AUTHORITATIVE');
    assert.equal(kernel.nextReadyWork(),null);

    // Once the read model converges, the same run settles without replaying.
    writeFileSync(readModel,'created');
    const done=kernel.reconcile(run);
    assert.equal(done.disposition,'DONE');
    assert.equal(done.verified,true);
    assert.equal(done.observed?.mutation_certainty,'present');
    assert.equal(kernel.inspect()[0].status,'DONE');

    assert.equal(effectAttempts,1);
    assert.equal(JSON.parse(readFileSync(providerTruth,'utf8')).accepted,true);
    assert.equal(done.claim_commit,run.claim_commit);
    assert.deepEqual(
      kernel.receipts(run.id).map(receipt=>receipt.disposition),
      ['RECOVERY_REQUIRED','RECOVERY_REQUIRED','RECOVERY_REQUIRED','DONE'],
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
