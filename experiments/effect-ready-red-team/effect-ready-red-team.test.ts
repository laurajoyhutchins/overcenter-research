import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bindTaskSession,
  executeAuthorizedEffect,
} from '../../src/effect-broker.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  derivePinnedProviderEffect,
  githubCommitStatusEffectAuthority,
} from '../../src/provider-effect.ts';
import { workerResult } from '../../src/realization.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'effect-authority-regression-'));
  const repo=join(root,'state.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel};
}

function fakeGithub() {
  let writes=0;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=String(input);
    if (url.endsWith('/repositories/123')) {
      return new Response(
        JSON.stringify({id:123,full_name:'owner/repo'}),
        {status:200,headers:{'Content-Type':'application/json'}},
      );
    }
    if (url.includes('/repos/owner/repo/statuses/')) {
      writes+=1;
      const body=JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id:1000+writes,
          state:body.state,
          context:body.context,
        }),
        {status:201,headers:{'Content-Type':'application/json'}},
      );
    }
    throw new Error('UNEXPECTED_FETCH:'+url);
  };
  return {fetchImpl,writes:()=>writes};
}

function defineStatusObligation(
  kernel:GitOvercenterKernel,
  id:string,
  {
    effect=true,
    acceptance=true,
  }:{
    effect?:boolean;
    acceptance?:boolean;
  }={},
) {
  const result={kind:'verified-result/v1',value:id};
  kernel.define({
    id,
    packet:{kind:'computation-task/v1'},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/'+id,
      expected_state:'success',
    },
    ...(effect?{effect_authority:githubCommitStatusEffectAuthority()}:{}),
    ...(acceptance
      ? {
          result_acceptance:{
            verifier:'canonical-json-sha256/v1' as const,
            expected_sha256:canonicalDigest(result),
          },
        }
      : {}),
  });
  const ready=kernel.deriveReadyWork();
  assert.ok(ready);
  const run=kernel.claim(id,ready.revision);
  const work=kernel.inspect().find(candidate=>candidate.id===id);
  assert.ok(work);
  const session=bindTaskSession(work);
  return {
    run,
    work,
    session,
    result:workerResult(session,result),
  };
}

test('fixed: dispatch-bound session cannot inherit newer authority',()=>{
  const f=fixture();
  try {
    const task=defineStatusObligation(f.kernel,'late-bind');
    const generationTwo=f.kernel.acquireExecution(task.run.id);
    assert.equal(generationTwo.execution_generation,2);

    assert.throws(
      ()=>f.kernel.acceptRealization(task.session,task.result),
      /TASK_SESSION_STALE/,
    );

    const current=f.kernel.inspect().find(candidate=>candidate.id===task.work.id);
    assert.ok(current);
    const lateBound=bindTaskSession(current);
    assert.throws(
      ()=>f.kernel.acceptRealization(lateBound,task.result),
      /WORKER_RESULT_SESSION_MISMATCH/,
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('fixed: observation-only postcondition cannot mint mutation authority',async()=>{
  const f=fixture();
  try {
    const task=defineStatusObligation(
      f.kernel,
      'observe-only',
      {effect:false,acceptance:true},
    );
    f.kernel.acceptRealization(task.session,task.result);
    const github=fakeGithub();

    await assert.rejects(
      executeAuthorizedEffect(
        f.kernel,
        task.session,
        {githubToken:'broker-token',githubFetch:github.fetchImpl},
      ),
      /EFFECT_AUTHORITY_REQUIRED/,
    );
    assert.equal(github.writes(),0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('fixed: provider effect cannot execute without accepted realization',async()=>{
  const f=fixture();
  try {
    const task=defineStatusObligation(f.kernel,'no-realization');
    const github=fakeGithub();

    await assert.rejects(
      executeAuthorizedEffect(
        f.kernel,
        task.session,
        {githubToken:'broker-token',githubFetch:github.fetchImpl},
      ),
      /REALIZATION_REQUIRED/,
    );
    assert.equal(github.writes(),0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('fixed: legacy arbitrary effect callback is no longer exported',async()=>{
  const module=await import('../../src/git-kernel.ts');
  assert.equal('runGitCoreLoop' in module,false);
});

test('fixed: reservation binds contract, adapter, exact effect, and realization',async()=>{
  const f=fixture();
  try {
    const task=defineStatusObligation(f.kernel,'exact-reservation');
    const realization=f.kernel.acceptRealization(task.session,task.result);
    const github=fakeGithub();
    const attempt=await executeAuthorizedEffect(
      f.kernel,
      task.session,
      {githubToken:'broker-token',githubFetch:github.fetchImpl},
    );
    assert.equal(github.writes(),1);

    const reservation=JSON.parse(
      execFileSync(
        'git',
        ['-C',f.repo,'show',attempt.reservation_commit+':effect-reservation.json'],
        {encoding:'utf8'},
      ),
    ) as Record<string,unknown>;

    assert.equal(
      reservation.effect_contract,
      task.work.effect_authority?.contract,
    );
    assert.equal(
      reservation.adapter_contract_digest,
      task.work.effect_authority?.adapter_contract_digest,
    );
    assert.equal(
      reservation.effect_digest,
      attempt.authorized_effect.effect_digest,
    );
    assert.equal(reservation.realization_commit,realization.realization_commit);
    assert.equal(reservation.realization_digest,realization.result_digest);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('fixed: kernel rejects forged exact-effect identity before reservation',()=>{
  const f=fixture();
  try {
    const task=defineStatusObligation(f.kernel,'forged-identity');
    const realization=f.kernel.acceptRealization(task.session,task.result);
    const permit=f.kernel.acquireExecution(task.run.id,{
      expectedGeneration:task.session.execution_generation,
      expectedAuthorityCommit:task.session.execution_authority_commit,
    });
    const effect=derivePinnedProviderEffect(task.work);
    assert.ok(effect);

    assert.throws(
      ()=>f.kernel.beginEffect(permit,{
        effect_contract:effect.effect_contract,
        adapter_contract_digest:effect.adapter_contract_digest,
        effect_digest:'0'.repeat(64),
        realization_commit:realization.realization_commit,
        realization_digest:realization.result_digest,
      }),
      /EFFECT_IDENTITY_MISMATCH/,
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
