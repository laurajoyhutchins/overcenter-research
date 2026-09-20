import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  controlDependency,
  GitKernelFixture,
} from './support/git-kernel-fixture.ts';

const STATE_REF='refs/overcenter/state';
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

test('GitOvercenterKernel reconstructs the same projection after every materialization is deleted',()=>{
  const f=new GitKernelFixture('overcenter-kernel-rebuild-');
  const cache=f.path('materialized');
  const world=f.path('provider-state.txt');

  const canonicalProjection=()=>{
    const work=f.kernel.inspect();
    const explanations=work.map(item=>f.kernel.explain(item.id));
    return `${JSON.stringify({work,explanations},null,2)}\n`;
  };

  const assertFactOnlyAuthority=()=>{
    for (const commit of f.git(['rev-list',STATE_REF]).split(/\n+/).filter(Boolean)) {
      assert.throws(()=>f.git(['cat-file','-e',`${commit}:state.json`]));
    }
  };

  const assertReconstructs=(expected:Array<[string,string]>)=>{
    const before=canonicalProjection();
    assert.deepEqual(
      (JSON.parse(before) as {
        work:Array<{id:string;status:string}>;
      }).work.map(work=>[work.id,work.status]),
      expected,
    );

    mkdirSync(cache,{recursive:true});
    writeFileSync(f.path('materialized/project-projection.json'),before);
    const digest=sha256(before);
    assertFactOnlyAuthority();

    rmSync(cache,{recursive:true,force:true});
    assert.equal(existsSync(cache),false);

    const fresh=f.freshKernel();
    const freshWork=fresh.kernel.inspect();
    const reconstructed=`${JSON.stringify({
      work:freshWork,
      explanations:freshWork.map(item=>fresh.kernel.explain(item.id)),
    },null,2)}\n`;
    assert.equal(reconstructed,before);
    assert.equal(sha256(reconstructed),digest);
  };

  try {
    f.defineFile('publish',{
      content:'present',
      path:world,
      packet:{path:world,content:'present'},
    });
    f.defineFile('verify-publish',{
      content:'verified',
      path:`${world}.verified`,
      dependencies:[controlDependency('publish')],
    });

    assertReconstructs([
      ['publish','READY'],
      ['verify-publish','BLOCKED'],
    ]);

    const run=f.claim('publish');
    const claimFact=JSON.parse(
      f.git(['show',`${run.claim_commit}:claim.json`]),
    ) as {
      run_id:string;
      obligation_id:string;
      claimed_revision:string;
    };
    assert.equal(claimFact.run_id,run.id);
    assert.equal(claimFact.obligation_id,'publish');
    assert.equal(claimFact.claimed_revision,run.claimed_revision);

    assertReconstructs([
      ['publish','EXECUTING'],
      ['verify-publish','BLOCKED'],
    ]);

    f.kernel.beginEffect(run);
    writeFileSync(world,'present');
    assertReconstructs([
      ['publish','EXECUTING'],
      ['verify-publish','BLOCKED'],
    ]);

    const recovery=f.kernel.recordExecutionTerminated(run,{
      source:'projection-erasure-proof',
    });
    assert.equal(recovery.disposition,'RECOVERY_REQUIRED');
    assert.equal(recovery.claim_commit,run.claim_commit);

    assertReconstructs([
      ['publish','RECOVERY_REQUIRED'],
      ['verify-publish','BLOCKED'],
    ]);

    const settled=f.kernel.reconcile(run);
    assert.equal(settled.disposition,'DONE');
    assert.equal(settled.claim_commit,run.claim_commit);

    assertReconstructs([
      ['publish','DONE'],
      ['verify-publish','READY'],
    ]);
  } finally {
    f.close();
  }
});
