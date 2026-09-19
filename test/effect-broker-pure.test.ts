import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitOvercenterKernel } from '../src/git-kernel.ts';
import type { Work } from '../src/model.ts';
import {
  bindTaskSession,
  executeEffectReady,
  resolveTaskSession,
} from '../src/effect-broker.ts';
import {
  effectReadySignal,
  validateEffectReadySignal,
} from '../src/execution-signal.ts';
import { deriveAuthorizedProviderEffect } from '../src/provider-effect.ts';

function githubWork(
  id:string,
  runId:string,
  generation=1,
):Work {
  return {
    id,
    dependencies:[],
    packet:{
      effect:{
        kind:'worker-forged-effect-must-be-ignored',
        repository_id:999,
        commit_sha:'f'.repeat(40),
        context:'forged',
        state:'failure',
      },
    },
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/authorized',
      expected_state:'success',
    },
    status:'EXECUTING',
    revision:'definition-head',
    run_id:runId,
    claimed_revision:'claim-head',
    execution_generation:generation,
  };
}

test('effect-ready signal contains no authority-bearing coordinates',()=>{
  const signal=effectReadySignal();
  assert.deepEqual(signal,{
    schema:'overcenter-worker-signal-v1',
    kind:'effect-ready',
  });

  for (const [field,value] of Object.entries({
    run_id:'other-run',
    obligation_id:'other-obligation',
    claimed_revision:'other-revision',
    repository_id:456,
    commit_sha:'b'.repeat(40),
    context:'overcenter/forged',
    state:'failure',
    effect:{kind:'github-commit-status/v1'},
  })) {
    assert.throws(
      ()=>validateEffectReadySignal({...signal,[field]:value}),
      /EFFECT_READY_SIGNAL_INVALID/,
    );
  }
});

test('server-side task session resolves exactly one run and generation',()=>{
  const left=githubWork('left','run-left',1);
  const right=githubWork('right','run-right',1);
  const session=bindTaskSession(left);

  assert.equal(resolveTaskSession([right,left],session),left);

  assert.throws(
    ()=>resolveTaskSession(
      [{...left,execution_generation:2}],
      session,
    ),
    /TASK_SESSION_STALE/,
  );

  assert.throws(
    ()=>resolveTaskSession(
      [{...left,id:'other'}],
      session,
    ),
    /TASK_SESSION_IDENTITY_MISMATCH/,
  );
});

test('provider mutation derives from authoritative postcondition, not packet effect',()=>{
  const work=githubWork('task','run-task');
  assert.deepEqual(
    deriveAuthorizedProviderEffect(work),
    {
      provider:'github',
      operation:'create-commit-status',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/authorized',
      state:'success',
    },
  );
});

test('broker uses trusted session run and expected generation, not worker payload',async()=>{
  const left=githubWork('left','run-left',4);
  const right=githubWork('right','run-right',9);
  const session=bindTaskSession(left);

  let acquired:{
    runId?:string;
    expectedGeneration?:number;
  }={};
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
      assert.equal(init?.method,'POST');
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        {
          state:'success',
          context:'overcenter/authorized',
          description:'Overcenter authorized effect broker',
        },
      );
      return new Response(JSON.stringify({
        id:777,
        state:'success',
        context:'overcenter/authorized',
      }),{
        status:201,
        headers:{'Content-Type':'application/json'},
      });
    }
    throw new Error('UNEXPECTED_FETCH:'+url);
  };

  const kernel={
    inspect:()=>[right,left],
    acquireExecution:(runId:string,{expectedGeneration}:{expectedGeneration?:number}={})=>{
      acquired={runId,expectedGeneration};
      return {
        id:runId,
        obligation_id:'left',
        claimed_revision:'claim-head',
        claim_commit:'claim-commit',
        obligation_key:'key',
        execution_generation:5,
        execution_authority_commit:'authority-commit',
        execution_capability_sha256:'digest',
        execution_capability:'secret',
      };
    },
    performEffect:async(_permit:unknown,effect:()=>Promise<unknown>)=>effect(),
  } as unknown as GitOvercenterKernel;

  const result=await executeEffectReady(
    kernel,
    session,
    effectReadySignal(),
    {
      githubToken:'broker-token',
      githubFetch:fakeFetch,
    },
  );

  assert.deepEqual(acquired,{
    runId:'run-left',
    expectedGeneration:4,
  });
  assert.equal(providerCalls,1);
  assert.equal(result.effect.repository_id,123);
  assert.equal(result.effect.context,'overcenter/authorized');
  assert.equal(result.broker_execution_generation,5);
});
