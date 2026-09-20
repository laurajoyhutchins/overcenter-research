import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitOvercenterKernel } from '../src/git-kernel.ts';
import type { Work } from '../src/model.ts';
import {
  bindTaskSession,
  executeAuthorizedEffect,
  resolveTaskSession,
  validateTaskSession,
} from '../src/effect-broker.ts';
import {
  deriveAuthorizedProviderEffect,
  derivePinnedProviderEffect,
  githubCommitStatusEffectAuthority,
} from '../src/provider-effect.ts';
import { canonicalDigest } from '../src/digest.ts';
import {
  verifyWorkerResult,
  workerResult,
} from '../src/realization.ts';

function githubWork(
  id:string,
  runId:string,
  generation=1,
  {
    effect=true,
    acceptance=true,
  }:{
    effect?:boolean;
    acceptance?:boolean;
  }={},
):Work {
  const expectedResult={kind:'test-result/v1',value:'accepted'};
  return {
    id,
    dependencies:[],
    packet:{kind:'test-task/v1'},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/authorized',
      expected_state:'success',
    },
    ...(effect?{effect_authority:githubCommitStatusEffectAuthority()}:{}),
    ...(acceptance
      ? {
          result_acceptance:{
            verifier:'canonical-json-sha256/v1' as const,
            expected_sha256:canonicalDigest(expectedResult),
          },
        }
      : {}),
    status:'EXECUTING',
    revision:'project-head',
    run_id:runId,
    claimed_revision:'claim-parent',
    execution_generation:generation,
    execution_authority_commit:'authority-'+generation,
  };
}

test('dispatch session binds exact execution authority commit and rejects extra fields',()=>{
  const session=bindTaskSession(githubWork('task','run-1',1));
  assert.deepEqual(validateTaskSession(session),session);
  assert.deepEqual(
    validateTaskSession({...session,run_id:'other'}),
    {...session,run_id:'other'},
  );
  assert.throws(
    ()=>validateTaskSession({...session,provider_target:'forged'}),
    /TASK_SESSION_INVALID/,
  );
});

test('session becomes stale when either generation or authority commit changes',()=>{
  const original=githubWork('left','run-left',1);
  const session=bindTaskSession(original);

  assert.equal(resolveTaskSession([original],session),original);
  assert.throws(
    ()=>resolveTaskSession(
      [{...original,execution_generation:2,execution_authority_commit:'authority-2'}],
      session,
    ),
    /TASK_SESSION_STALE/,
  );
  assert.throws(
    ()=>resolveTaskSession(
      [{...original,execution_authority_commit:'different'}],
      session,
    ),
    /TASK_SESSION_STALE/,
  );
});

test('postcondition without explicit effect authority cannot derive a provider mutation',()=>{
  const observeOnly=githubWork('observe','run-observe',1,{effect:false});
  assert.equal(derivePinnedProviderEffect(observeOnly),null);
  assert.equal(deriveAuthorizedProviderEffect(observeOnly),null);
});

test('effect grant pins the adapter contract used for execution',()=>{
  const work=githubWork('task','run-task');
  const pinned=derivePinnedProviderEffect(work);
  const executable=deriveAuthorizedProviderEffect(work);
  assert.ok(pinned);
  assert.deepEqual(executable,pinned);

  const stale={
    ...work,
    effect_authority:{
      ...work.effect_authority!,
      adapter_contract_digest:'0'.repeat(64),
    },
  };
  assert.ok(derivePinnedProviderEffect(stale));
  assert.throws(
    ()=>deriveAuthorizedProviderEffect(stale),
    /EFFECT_ADAPTER_CONTRACT_MISMATCH/,
  );
});

test('worker result becomes readiness only after deterministic acceptance',()=>{
  const work=githubWork('task','run-task');
  const session=bindTaskSession(work);
  const valid=workerResult(session,{kind:'test-result/v1',value:'accepted'});
  const verified=verifyWorkerResult(work,session,valid);
  assert.equal(verified.result_digest,work.result_acceptance?.expected_sha256);

  assert.throws(
    ()=>verifyWorkerResult(
      work,
      session,
      workerResult(session,{kind:'test-result/v1',value:'forged'}),
    ),
    /WORKER_RESULT_REJECTED/,
  );

  const rebound=bindTaskSession({
    ...work,
    execution_generation:2,
    execution_authority_commit:'authority-2',
  });
  assert.throws(
    ()=>verifyWorkerResult(work,rebound,valid),
    /WORKER_RESULT_SESSION_MISMATCH/,
  );
});

test('broker requires durable realization and reserves exact effect identity',async()=>{
  const work=githubWork('left','run-left',4);
  const session=bindTaskSession(work);
  const authorized=deriveAuthorizedProviderEffect(work);
  assert.ok(authorized);

  const realization={
    schema:'overcenter-git-realization-v1' as const,
    run_id:'run-left',
    obligation_id:'left',
    claimed_revision:'claim-parent',
    execution_generation:4,
    execution_authority_commit:'authority-4',
    verifier:'canonical-json-sha256/v1' as const,
    result_digest:work.result_acceptance!.expected_sha256,
    realization_commit:'realization-commit',
  };

  let acquired:Record<string,unknown>={};
  let reserved:Record<string,unknown>={};
  let providerCalls=0;

  const fakeFetch:typeof fetch=async(input,init)=>{
    const url=String(input);
    if (url.endsWith('/repositories/123')) {
      return new Response(JSON.stringify({id:123,full_name:'owner/repo'}),{
        status:200,
        headers:{'Content-Type':'application/json'},
      });
    }
    if (url.includes('/repos/owner/repo/statuses/')) {
      providerCalls+=1;
      const body=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id:777,
        state:body.state,
        context:body.context,
      }),{
        status:201,
        headers:{'Content-Type':'application/json'},
      });
    }
    throw new Error('UNEXPECTED_FETCH:'+url);
  };

  const kernel={
    inspect:()=>[work],
    acceptedRealization:()=>realization,
    acquireExecution:(
      runId:string,
      opts:{expectedGeneration?:number;expectedAuthorityCommit?:string}={},
    )=>{
      acquired={runId,...opts};
      return {
        id:runId,
        obligation_id:'left',
        claimed_revision:'claim-parent',
        claim_commit:'claim-commit',
        obligation_key:'key',
        execution_generation:5,
        execution_authority_commit:'authority-5',
        execution_capability_sha256:'digest',
        execution_capability:'secret',
      };
    },
    beginEffect:(_permit:unknown,identity:Record<string,unknown>)=>{
      reserved=identity;
      return 'reservation-commit';
    },
  } as unknown as GitOvercenterKernel;

  const attempt=await executeAuthorizedEffect(
    kernel,
    session,
    {githubToken:'broker-token',githubFetch:fakeFetch},
  );

  assert.deepEqual(acquired,{
    runId:'run-left',
    expectedGeneration:4,
    expectedAuthorityCommit:'authority-4',
  });
  assert.equal(providerCalls,1);
  assert.equal(reserved.effect_contract,authorized.effect_contract);
  assert.equal(reserved.adapter_contract_digest,authorized.adapter_contract_digest);
  assert.equal(reserved.effect_digest,authorized.effect_digest);
  assert.equal(reserved.realization_commit,'realization-commit');
  assert.equal(reserved.realization_digest,realization.result_digest);
  assert.equal(attempt.reservation_commit,'reservation-commit');
});

test('broker fails before authority acquisition when realization is missing',async()=>{
  const work=githubWork('left','run-left',1);
  const session=bindTaskSession(work);
  let acquired=false;
  const kernel={
    inspect:()=>[work],
    acceptedRealization:()=>null,
    acquireExecution:()=>{ acquired=true; throw new Error('SHOULD_NOT_RUN'); },
  } as unknown as GitOvercenterKernel;

  await assert.rejects(
    executeAuthorizedEffect(kernel,session,{githubToken:'broker-token'}),
    /REALIZATION_REQUIRED/,
  );
  assert.equal(acquired,false);
});
