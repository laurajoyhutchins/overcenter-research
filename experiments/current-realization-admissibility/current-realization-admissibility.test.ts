import assert from 'node:assert/strict';
import {
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';

import { GitKernelFixture } from '../../test/support/git-kernel-fixture.ts';

function snapshot(f:GitKernelFixture,id:string) {
  const work=f.kernel.inspect().find(candidate=>candidate.id===id);
  assert.ok(work);
  return {
    work,
    explanation:f.kernel.explain(id),
  };
}

test('authoritative contradiction withdraws DONE without invalidation state and exact truth can return',()=>{
  const f=new GitKernelFixture('current-realization-strong-');
  try {
    const path=f.path('mutable.txt');
    f.defineFile('mutable',{path,content:'desired'});
    const settled=f.settleFile('mutable');

    const done=snapshot(f,'mutable');
    assert.equal(done.work.status,'DONE');
    assert.equal(done.work.run_id,settled.id);
    assert.equal(done.explanation.status,'DONE');
    assert.equal(done.explanation.reason.kind,'admissible-realization');
    if (done.explanation.reason.kind!=='admissible-realization') {
      assert.fail('expected admissible realization');
    }
    assert.equal(
      done.explanation.reason.admissibility_basis,
      'current-semantic-judgment',
    );

    writeFileSync(path,'drifted');
    const drifted=snapshot(f,'mutable');
    assert.equal(drifted.work.status,'READY');
    assert.equal(drifted.explanation.status,'READY');
    assert.equal(drifted.explanation.reason.kind,'claimable');
    if (drifted.explanation.reason.kind!=='claimable') {
      assert.fail('expected claimable explanation');
    }
    assert.deepEqual(drifted.explanation.reason.rejected_realization,{
      run_id:settled.id,
      disposition:'DONE',
      reason:'not-currently-admissible',
      settlement_commit:f.kernel.receipts(settled.id).at(-1)?.settlement_commit,
    });

    const freshAfterDrift=f.freshKernel().kernel;
    assert.deepEqual(
      {
        work:freshAfterDrift.inspect(),
        explanation:freshAfterDrift.explain('mutable'),
      },
      {
        work:f.kernel.inspect(),
        explanation:f.kernel.explain('mutable'),
      },
    );

    unlinkSync(path);
    assert.equal(f.kernel.inspect()[0]?.status,'READY');

    writeFileSync(path,'desired');
    const restored=snapshot(f,'mutable');
    assert.equal(restored.work.status,'DONE');
    assert.equal(restored.work.run_id,settled.id);
    assert.equal(
      f.kernel.receipts(settled.id).filter(receipt=>receipt.disposition==='DONE').length,
      1,
      'restoring reality must not require another settlement',
    );
  } finally {
    f.close();
  }
});

test('indeterminate current evidence blocks replay and reconstructs identically',()=>{
  const f=new GitKernelFixture('current-realization-eventual-');
  try {
    const path=f.path('eventual.txt');
    f.defineFile('eventual',{
      path,
      content:'desired',
      consistency:'eventual',
    });
    const settled=f.settleFile('eventual');
    assert.equal(f.kernel.inspect()[0]?.status,'DONE');

    writeFileSync(path,'stale');
    const stale=snapshot(f,'eventual');
    assert.equal(stale.work.status,'BLOCKED');
    assert.equal(
      stale.work.blocked_reason,
      'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE',
    );
    assert.equal(stale.explanation.status,'BLOCKED');
    assert.equal(
      stale.explanation.reason.kind,
      'current-realization-indeterminate',
    );
    if (stale.explanation.reason.kind!=='current-realization-indeterminate') {
      assert.fail('expected indeterminate realization explanation');
    }
    assert.equal(
      stale.explanation.reason.reason,
      'NON_MATCHING_READ_NOT_AUTHORITATIVE',
    );
    assert.equal(f.kernel.nextReadyWork(),null);
    assert.throws(
      ()=>f.kernel.claim('eventual',stale.work.revision),
      /CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE/,
    );

    const fresh=f.freshKernel().kernel;
    assert.deepEqual(fresh.inspect(),f.kernel.inspect());
    assert.deepEqual(fresh.explain('eventual'),f.kernel.explain('eventual'));

    unlinkSync(path);
    const absent=snapshot(f,'eventual');
    assert.equal(absent.work.status,'BLOCKED');
    assert.equal(absent.explanation.reason.kind,'current-realization-indeterminate');
    if (absent.explanation.reason.kind!=='current-realization-indeterminate') {
      assert.fail('expected indeterminate realization explanation');
    }
    assert.equal(
      absent.explanation.reason.reason,
      'NEGATIVE_READ_NOT_AUTHORITATIVE',
    );

    writeFileSync(path,'desired');
    const restored=snapshot(f,'eventual');
    assert.equal(restored.work.status,'DONE');
    assert.equal(restored.work.run_id,settled.id);
  } finally {
    f.close();
  }
});
