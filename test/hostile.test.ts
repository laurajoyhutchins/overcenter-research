import assert from 'node:assert/strict';
import test from 'node:test';

import { projectExecutionAuthority } from '../src/transaction-admission.ts';

import './semantic-identity-hostile.test.ts';
import './observation-hostile.test.ts';

test('execution authority projection rejects every inexact identity component',()=>{
  const run={
    id:'run',obligation_id:'obligation',claimed_revision:'revision',
    claim_commit:'claim',obligation_key:'key',execution_generation:7,
    execution_authority_commit:'authority',execution_capability_sha256:'capability',
  };
  const permit={...run,execution_capability:'secret'};
  assert.deepEqual(
    projectExecutionAuthority(run,permit,'capability'),
    {current_authority:true,exact_revision:true},
  );
  for (const [hostile,presented='capability'] of [
    [{...permit,id:'other'}],
    [{...permit,obligation_id:'other'}],
    [{...permit,claimed_revision:'other'}],
    [{...permit,claim_commit:'other'}],
    [{...permit,obligation_key:'other'}],
    [{...permit,execution_generation:8}],
    [{...permit,execution_authority_commit:'other'}],
    [{...permit,execution_capability_sha256:'other'}],
    [permit,'other'],
  ] as const) {
    const projected=projectExecutionAuthority(run,hostile,presented);
    assert.equal(projected.current_authority&&projected.exact_revision,false);
  }
});
