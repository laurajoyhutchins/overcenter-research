import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {OvercenterKernel} from '../../src/authority/kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';

const COMMIT='a'.repeat(40);

function repository() {
  return {
    id:42,
    node_id:'R_42',
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
  };
}

function define(kernel:OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id:'authority-decay',
    packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:42,
      repository_full_name:'acme/widget',
      commit_sha:COMMIT,
      context:'overcenter/authority-decay',
      expected_state:'success',
    },
  });
  const work=kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(work.id,work.revision);
}

test('bound authority rejects raw permit/work mismatch before provider I/O',async()=>{
  const root=mkdtempSync(join(tmpdir(),'effect-authority-mismatch-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let reads=0;
  let posts=0;
  try {
    const permit=define(kernel);
    const mismatched={...permit,obligation_id:'wrong-obligation'};
    await assert.rejects(
      performGithubCommitStatusEffect(kernel,mismatched,{
        token:'token',
        get:async()=>{reads+=1; return repository();},
        post:async()=>{posts+=1; return {status:201,body:'{}'};},
      }),
      /EFFECT_AUTHORITY_RUN_MISMATCH/,
    );
    assert.equal(reads,0);
    assert.equal(posts,0);
    assert.equal(kernel.hasUnresolvedEffect(permit.id),false);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('final runtime fence rejects authority superseded after binding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'effect-authority-stale-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let reads=0;
  let posts=0;
  try {
    const permit=define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel,permit,{
        token:'token',
        get:async()=>{
          reads+=1;
          if (reads===1) kernel.acquireExecution(permit.id);
          return repository();
        },
        post:async()=>{posts+=1; return {status:201,body:'{}'};},
      }),
      /STALE_EXECUTION_GENERATION/,
    );
    assert.equal(reads,1);
    assert.equal(posts,0);
    assert.equal(kernel.hasUnresolvedEffect(permit.id),false);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});
