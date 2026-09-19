import assert from 'node:assert/strict';
import test from 'node:test';
import type { Work } from '../../src/model.ts';
import {
  authorizeEffectRequest,
  expectedEffectRequest,
} from '../../src/effect-request.ts';

function work():Work {
  return {
    id:'task',
    dependencies:[],
    packet:{
      effect:{
        kind:'github-commit-status/v1',
        repository_id:123,
        commit_sha:'a'.repeat(40),
        context:'overcenter/capability',
        state:'success',
      },
    },
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/capability',
      expected_state:'success',
    },
    status:'EXECUTING',
    revision:'definition-head',
    run_id:'run-1',
    claimed_revision:'claim-head',
    execution_generation:1,
  };
}

test('broker re-derives the exact effect request from authoritative work',()=>{
  const authoritative=work();
  const request=expectedEffectRequest(authoritative);
  assert.deepEqual(authorizeEffectRequest(authoritative,request),request);
});

test('mutating any authority-bearing request coordinate is rejected',()=>{
  const authoritative=work();
  const valid=expectedEffectRequest(authoritative);

  const mutations:Array<(value:any)=>void>=[
    value=>{ value.obligation_id='other'; },
    value=>{ value.run_id='other-run'; },
    value=>{ value.claimed_revision='other-revision'; },
    value=>{ value.effect.repository_id=456; },
    value=>{ value.effect.commit_sha='b'.repeat(40); },
    value=>{ value.effect.context='overcenter/forged'; },
    value=>{ value.effect.state='failure'; },
    value=>{ value.effect.kind='github-commit-status/v9'; },
    value=>{ value.extra='smuggled'; },
  ];

  for (const mutate of mutations) {
    const forged=structuredClone(valid) as any;
    mutate(forged);
    assert.throws(
      ()=>authorizeEffectRequest(authoritative,forged),
      /EFFECT_REQUEST_NOT_AUTHORIZED/,
    );
  }
});

test('worker cannot authorize an effect absent from authoritative packet',()=>{
  const authoritative=work();
  authoritative.packet={};
  assert.throws(
    ()=>expectedEffectRequest(authoritative),
    /EFFECT_REQUEST_EFFECT_MISSING/,
  );
});
