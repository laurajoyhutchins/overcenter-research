import assert from 'node:assert/strict';
import test from 'node:test';
import { Experiment, semantic } from './experiment.ts';

function withExperiment(
  name:string,
  body:(experiment:Experiment)=>void,
) {
  test(name,()=>{
    const x=new Experiment();
    try {
      body(x);
    } finally {
      x.close();
    }
  });
}

withExperiment('material packet change invalidates an otherwise identical realization',x=>{
  x.define('artifact',{content:'same-bytes',packet:{producer:'v1'}});
  x.settle('artifact');
  const before=x.work('artifact');

  x.amend('artifact',{content:'same-bytes',packet:{producer:'v2'}});
  const after=x.work('artifact');

  assert.equal(before.status,'DONE');
  assert.equal(after.status,'READY');
  assert.equal(after.run_id,undefined);
});

withExperiment('producer-local changes preserve a consumer of unchanged verified output',x=>{
  x.define('producer',{content:'stable-output',packet:{implementation:'v1'}});
  x.define('consumer',{
    content:'consumer-output',
    dependencies:[semantic('producer')],
  });
  x.settle('producer');
  x.settle('consumer');
  const before=x.work('consumer');

  x.amend('producer',{content:'stable-output',packet:{implementation:'v2'}});
  x.settle('producer');
  const after=x.work('consumer');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withExperiment('semantic dependency declaration order is identity-neutral',x=>{
  x.define('alpha',{content:'A'});
  x.define('charlie',{content:'C'});
  x.define('consumer',{
    content:'result',
    dependencies:[semantic('alpha'),semantic('charlie')],
  });
  x.settle('alpha');
  x.settle('charlie');
  x.settle('consumer');
  const before=x.work('consumer');

  x.amend('consumer',{
    content:'result',
    dependencies:[semantic('charlie'),semantic('alpha')],
  });
  const after=x.work('consumer');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withExperiment('only the newest execution generation can reserve an effect',x=>{
  x.define('effect',{content:'done'});
  const generation1=x.claim('effect');
  const generation2=x.kernel.acquireExecution(generation1.id);
  const generation3=x.kernel.acquireExecution(generation2.id);

  assert.throws(()=>x.kernel.beginEffect(generation1),/STALE_EXECUTION_GENERATION/);
  assert.throws(()=>x.kernel.beginEffect(generation2),/STALE_EXECUTION_GENERATION/);
  assert.doesNotThrow(()=>x.kernel.beginEffect(generation3));
});

withExperiment('recovery-required state reconstructs without worker-local state',x=>{
  x.define('resource',{content:'created',consistency:'eventual'});
  const run=x.claim('resource');
  x.kernel.beginEffect(run);
  x.write('resource','created');
  x.kernel.recoverInterrupted(run,{source:'experiment-worker-death'});

  const owner=x.snapshot();
  const reconstructed=x.reconstruct();

  assert.equal(x.work('resource',owner).status,'RECOVERY_REQUIRED');
  assert.equal(x.work('resource',reconstructed).status,'RECOVERY_REQUIRED');
  assert.deepEqual(reconstructed,owner);
});

withExperiment('uncertain readback never authorizes blind replay',x=>{
  x.define('resource',{content:'created',consistency:'eventual'});
  const run=x.claim('resource');
  x.kernel.beginEffect(run);
  x.kernel.recoverInterrupted(run,{source:'experiment-worker-death'});

  const missing=x.kernel.reconcile(run);
  assert.equal(missing.disposition,'RECOVERY_REQUIRED');
  assert.equal(missing.observed?.mutation_certainty,'uncertain');
  assert.equal(
    missing.observed?.observation_error,
    'NEGATIVE_READ_NOT_AUTHORITATIVE',
  );

  x.write('resource','old-value');
  const stale=x.kernel.reconcile(run);
  assert.equal(stale.disposition,'RECOVERY_REQUIRED');
  assert.equal(
    stale.observed?.observation_error,
    'NON_MATCHING_READ_NOT_AUTHORITATIVE',
  );

  x.write('resource','created');
  const converged=x.kernel.reconcile(run);
  assert.equal(converged.disposition,'DONE');
  assert.equal(converged.observed?.mutation_certainty,'present');
  assert.deepEqual(
    x.kernel.receipts(run.id).map(receipt=>receipt.disposition),
    ['RECOVERY_REQUIRED','RECOVERY_REQUIRED','RECOVERY_REQUIRED','DONE'],
  );
});
