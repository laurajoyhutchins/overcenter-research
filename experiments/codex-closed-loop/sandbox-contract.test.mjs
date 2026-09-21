import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const here=new URL('./',import.meta.url);
const profile=JSON.parse(readFileSync(new URL('./sandbox-profile.json',here),'utf8'));
const objective=JSON.parse(readFileSync(new URL('./sandbox-fixture/objective.json',here),'utf8'));

test('autonomy sandbox owns only disposable local authority',()=>{
  assert.equal(profile.schema,'overcenter-autonomy-sandbox/v1');
  assert.equal(profile.authority.kind,'sqlite');
  assert.equal(profile.authority.location_policy,'temporary-directory-only');
  assert.equal(profile.authority.persistent,false);
  assert.equal(profile.authority.production_database_allowed,false);
  assert.equal(profile.external_effects.real_provider_mutation,false);
});

test('reasoning worker has no path to real project mutation',()=>{
  assert.equal(profile.worker.project_bytes,'synthetic-fixture-only');
  assert.equal(profile.worker.provider_credentials,'none');
  assert.equal(profile.worker.repository_write_credentials,'none');
  assert.equal(profile.worker.publication_authority,'none');
});

test('sandbox runs are bounded and seed-addressable',()=>{
  assert.equal(profile.evidence.seed_required,true);
  assert.equal(profile.evidence.record_fault_schedule,true);
  assert.equal(profile.evidence.record_transition_identities,true);
  assert.equal(profile.evidence.record_human_interventions,true);
  assert.equal(profile.limits.max_settled_transitions,100);
  assert.ok(profile.limits.max_attempts_per_transition>0);
});

test('capability ladder adds autonomy without changing authority topology',()=>{
  assert.deepEqual(profile.stages.map(stage=>stage.id),[1,2,3,4,5,6,7]);
  assert.equal(profile.stages[0].target_settlements,1);
  assert.equal(profile.stages[1].target_settlements,10);
  assert.ok(profile.stages[2].faults.includes('before-settlement'));
  assert.equal(profile.stages.at(-1).target_settlements,100);
});

test('promotion cannot be triggered by experiment success',()=>{
  assert.equal(profile.promotion.automatic,false);
  assert.equal(profile.promotion.separate_reviewed_change_required,true);
  assert.ok(profile.promotion.required_invariants.includes('false_done_count == 0'));
  assert.ok(profile.promotion.required_invariants.includes('writes_outside_sandbox == 0'));
  assert.ok(profile.promotion.required_invariants.includes('hidden_human_state_repairs == 0'));
});

test('synthetic objective is objective-level and mechanically finishable',()=>{
  assert.equal(objective.id,'typescript-migration');
  assert.equal(objective.acceptance.expected_remaining_count,0);
  assert.match(objective.acceptance.command,/verify\.mjs/);
  assert.ok(objective.constraints.some(value=>value.includes('no .js file remains')));
});
