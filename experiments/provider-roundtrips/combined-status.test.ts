import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCombinedStatus } from './combined-status.ts';

const expected={
  repositoryId:42,
  repositoryFullName:'acme/widget',
  commitSha:'a'.repeat(40),
  context:'Overcenter/Example',
  state:'success' as const,
};

const fixture=()=>({
  state:'success',
  sha:expected.commitSha,
  total_count:1,
  repository:{
    id:42,
    node_id:'R_42',
    name:'widget',
    full_name:'acme/widget',
    owner:{login:'acme'},
  },
  statuses:[{
    id:7,
    node_id:'STATUS_7',
    state:'success',
    context:'overcenter/example',
  }],
});

test('combined status binds repository, SHA, context, and state in one response',()=>{
  assert.doesNotThrow(()=>assertCombinedStatus(fixture(),expected));
});

for (const [name,mutate,error] of [
  ['repository id',v=>{v.repository.id=99;},'COMBINED_STATUS_REPOSITORY_ID_MISMATCH'],
  ['repository alias',v=>{v.repository.full_name='other/widget';},'COMBINED_STATUS_REPOSITORY_NAME_MISMATCH'],
  ['commit sha',v=>{v.sha='b'.repeat(40);},'COMBINED_STATUS_SHA_MISMATCH'],
  ['status context',v=>{v.statuses[0].context='other';},'COMBINED_STATUS_TARGET_MISSING'],
  ['status state',v=>{v.statuses[0].state='failure';},'COMBINED_STATUS_STATE_MISMATCH'],
] as const) {
  test(`combined status fails closed on ${name} mismatch`,()=>{
    const value=fixture();
    mutate(value as never);
    assert.throws(()=>assertCombinedStatus(value,expected),new RegExp(error));
  });
}
