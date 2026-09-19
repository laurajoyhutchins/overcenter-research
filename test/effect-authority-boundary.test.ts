import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OvercenterKernel, runCoreLoop } from '../src/kernel.ts';
import { canonicalDigest } from '../src/digest.ts';
import { bindTaskSession, executeAuthorizedEffect } from '../src/effect-broker.ts';
import {
  deriveAuthorizedProviderEffect,
  githubCommitStatusEffectAuthority,
} from '../src/provider-effect.ts';
import { workerResult } from '../src/realization.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-effect-authority-'));
  const db=join(root,'authority.sqlite');
  const kernel=new OvercenterKernel(db);
  kernel.initialize();
  return {root,kernel};
}

function defineEffect(kernel:OvercenterKernel,id:string,{effect=true}:{effect?:boolean}={}) {
  const result={kind:'verified-result/v1',value:id};
  kernel.define({
    id,
    packet:{kind:'worker-task/v1'},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/'+id,
      expected_state:'success',
    },
    ...(effect?{effect_authority:githubCommitStatusEffectAuthority()}:{}),
    ...(effect?{result_acceptance:{
      verifier:'canonical-json-sha256/v1' as const,
      expected_sha256:canonicalDigest(result),
    }}:{}),
  });
  const ready=kernel.deriveReadyWork();
  assert.ok(ready);
  kernel.claim(id,ready.revision);
  const work=kernel.inspect().find(candidate=>candidate.id===id);
  assert.ok(work);
  const session=bindTaskSession(work);
  return {work,session,result:workerResult(session,result)};
}

function fakeGithub() {
  let writes=0;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=String(input);
    if (url.endsWith('/repositories/123')) {
      return new Response(JSON.stringify({id:123,full_name:'owner/repo'}),{status:200});
    }
    if (url.includes('/repos/owner/repo/statuses/')) {
      writes+=1;
      const body=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({id:777,state:body.state,context:body.context}),{status:201});
    }
    throw new Error('UNEXPECTED_FETCH:'+url);
  };
  return {fetchImpl,writes:()=>writes};
}

test('effect authority requires deterministic result acceptance',()=>{
  const f=fixture();
  try {
    assert.throws(()=>f.kernel.define({
      id:'missing-acceptance',
      packet:{kind:'worker-task/v1'},
      postcondition:{
        verifier:'github-commit-status/v1',
        provider:'github',
        repository_id:123,
        commit_sha:'a'.repeat(40),
        context:'overcenter/missing',
        expected_state:'success',
      },
      effect_authority:githubCommitStatusEffectAuthority(),
    }),/EFFECT_RESULT_ACCEPTANCE_REQUIRED/);
  } finally { f.kernel.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('dispatch-bound session and result cannot inherit rotated authority',()=>{
  const f=fixture();
  try {
    const task=defineEffect(f.kernel,'stale-session');
    f.kernel.acquireExecution(task.session.run_id);
    assert.throws(
      ()=>f.kernel.acceptRealization(task.session,task.result),
      /TASK_SESSION_STALE/,
    );

    const successorWork=f.kernel.inspect().find(work=>work.id==='stale-session');
    assert.ok(successorWork);
    const successorSession=bindTaskSession(successorWork);
    assert.equal(successorSession.execution_generation,2);
    assert.throws(
      ()=>f.kernel.acceptRealization(successorSession,task.result),
      /WORKER_RESULT_SESSION_MISMATCH/,
    );
  } finally { f.kernel.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('generic loop rejects provider work before changing authority',async()=>{
  const f=fixture();
  try {
    f.kernel.define({
      id:'observe-only',
      packet:{kind:'observe-only/v1'},
      postcondition:{
        verifier:'github-commit-status/v1',
        provider:'github',
        repository_id:123,
        commit_sha:'a'.repeat(40),
        context:'overcenter/observe-only',
        expected_state:'success',
      },
    });
    const before=f.kernel.head();
    await assert.rejects(
      runCoreLoop(f.kernel,{
        effect:async()=>({kind:'forbidden'}),
        maxAdvances:1,
      }),
      /PROVIDER_EFFECT_BROKER_REQUIRED/,
    );
    assert.equal(f.kernel.head(),before);
    assert.equal(f.kernel.inspect()[0]?.status,'READY');

    const ready=f.kernel.deriveReadyWork();
    assert.ok(ready);
    const permit=f.kernel.claim('observe-only',ready.revision);
    const work=f.kernel.inspect()[0]!;
    assert.equal(deriveAuthorizedProviderEffect(work),null);
    assert.throws(
      ()=>f.kernel.beginEffect(permit),
      /EFFECT_AUTHORITY_REQUIRED/,
    );
    await assert.rejects(
      f.kernel.performEffect(permit,async()=>({kind:'forbidden'})),
      /PROVIDER_EFFECT_BROKER_REQUIRED/,
    );
  } finally { f.kernel.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('broker requires accepted realization and reserves before provider mutation',async()=>{
  const f=fixture();
  try {
    const task=defineEffect(f.kernel,'verified-effect');
    const github=fakeGithub();
    await assert.rejects(
      executeAuthorizedEffect(f.kernel,task.session,{
        githubToken:'broker-token',
        githubFetch:github.fetchImpl,
      }),
      /REALIZATION_REQUIRED/,
    );
    assert.equal(github.writes(),0);

    const realization=f.kernel.acceptRealization(task.session,task.result);

    await assert.rejects(
      executeAuthorizedEffect(f.kernel,task.session,{}),
      /GITHUB_EFFECT_TOKEN_MISSING/,
    );
    assert.equal(
      f.kernel.inspect().find(work=>work.id==='verified-effect')?.execution_generation,
      1,
    );
    assert.equal(f.kernel.hasUnresolvedEffect(task.session.run_id),false);

    const attempt=await executeAuthorizedEffect(f.kernel,task.session,{
      githubToken:'broker-token',
      githubFetch:github.fetchImpl,
    });
    assert.equal(github.writes(),1);
    assert.equal(attempt.broker_execution_generation,2);
    assert.equal(attempt.authorized_effect.effect_digest.length,64);
    assert.ok(attempt.reservation_commit);
    assert.equal(realization.result_digest,task.work.result_acceptance?.expected_sha256);
    assert.equal(f.kernel.hasUnresolvedEffect(task.session.run_id),true);
  } finally { f.kernel.close(); rmSync(f.root,{recursive:true,force:true}); }
});

test('effect identity and acceptance contract contribute to obligation key',()=>{
  const a=fixture();
  const b=fixture();
  try {
    const result={kind:'verified-result/v1',value:'identity'};
    const base={
      id:'identity',
      packet:{kind:'worker-task/v1'},
      postcondition:{
        verifier:'github-commit-status/v1' as const,
        provider:'github' as const,
        repository_id:123,
        commit_sha:'a'.repeat(40),
        context:'overcenter/identity',
        expected_state:'success' as const,
      },
      effect_authority:githubCommitStatusEffectAuthority(),
      result_acceptance:{
        verifier:'canonical-json-sha256/v1' as const,
        expected_sha256:canonicalDigest(result),
      },
    };
    a.kernel.define(base);
    b.kernel.define({
      ...base,
      result_acceptance:{
        ...base.result_acceptance,
        expected_sha256:canonicalDigest({...result,value:'different'}),
      },
    });
    const wa=a.kernel.deriveReadyWork();
    const wb=b.kernel.deriveReadyWork();
    assert.ok(wa); assert.ok(wb);
    const ra=a.kernel.claim('identity',wa.revision);
    const rb=b.kernel.claim('identity',wb.revision);
    assert.notEqual(ra.obligation_key,rb.obligation_key);
  } finally {
    a.kernel.close(); b.kernel.close();
    rmSync(a.root,{recursive:true,force:true});
    rmSync(b.root,{recursive:true,force:true});
  }
});
