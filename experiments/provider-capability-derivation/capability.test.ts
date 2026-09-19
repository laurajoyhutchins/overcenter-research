import assert from 'node:assert/strict';
import test from 'node:test';
import type { Postcondition } from '../../src/model.ts';
import type { State } from '../../src/facts.ts';
import { validateAdmission } from '../../src/admission.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';
import {
  classifyCapabilityRelation,
  deriveCapabilityRelation,
  deriveMutationCapabilityFootprint,
  type MutationCapabilityFootprint,
} from './capability.ts';

function status(
  expected_state:'error'|'failure'|'pending'|'success',
  {
    repository_id=123,
    commit_sha='a'.repeat(40),
    context='overcenter/Build',
  }:{
    repository_id?:number;
    commit_sha?:string;
    context?:string;
  }={},
):Postcondition {
  return {
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id,
    commit_sha,
    context,
    expected_state,
  };
}

function statusV2(
  repository_full_name:string,
):Postcondition {
  return {
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:123,
    repository_full_name,
    commit_sha:'a'.repeat(40),
    context:'overcenter/Build',
    expected_state:'success',
  };
}

function file(path='/tmp/effect'):Postcondition {
  return {
    verifier:'file-content-equals/v1',
    path,
    content:'value',
  };
}

function state(
  left:Postcondition,
  right:Postcondition,
  ordered=false,
):State {
  return {
    obligations:{
      alpha:{
        id:'alpha',
        dependencies:[],
        packet:{},
        postcondition:left,
        ...(left.verifier==='github-commit-status/v1'
          || left.verifier==='github-commit-status/v2'
          ? {effect_authority:githubCommitStatusEffectAuthority()}
          : {}),
      },
      beta:{
        id:'beta',
        dependencies:ordered
          ? [{kind:'control' as const,upstream:'alpha'}]
          : [],
        packet:{},
        postcondition:right,
        ...(right.verifier==='github-commit-status/v1'
          || right.verifier==='github-commit-status/v2'
          ? {effect_authority:githubCommitStatusEffectAuthority()}
          : {}),
      },
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };
}

test('derives the physical GitHub status coordinate and settlement-equivalence witness',()=>{
  const footprint=deriveMutationCapabilityFootprint(status('success'));
  assert.ok(footprint);
  assert.equal(
    footprint.physical_resource,
    `github-status:123:${'a'.repeat(40)}:overcenter/build`,
  );
  assert.equal(footprint.semantic_operation,'success');
  assert.match(footprint.settlement_equivalence_witness_digest??'',/^[0-9a-f]{64}$/);
});

test('GitHub status context case is normalized before capability derivation',()=>{
  const upper=deriveMutationCapabilityFootprint(
    status('success',{context:'overcenter/Build'}),
  );
  const lower=deriveMutationCapabilityFootprint(
    status('success',{context:'overcenter/build'}),
  );
  assert.ok(upper);
  assert.ok(lower);
  assert.equal(upper.physical_resource,lower.physical_resource);
  assert.equal(
    upper.settlement_equivalence_witness_digest,
    lower.settlement_equivalence_witness_digest,
  );
});

test('GitHub v2 repository rename does not change capability identity',()=>{
  const before=deriveMutationCapabilityFootprint(statusV2('owner/old-name'));
  const after=deriveMutationCapabilityFootprint(statusV2('owner/new-name'));
  assert.ok(before);
  assert.ok(after);
  assert.equal(before.physical_resource,after.physical_resource);
  assert.equal(
    before.settlement_equivalence_witness_digest,
    after.settlement_equivalence_witness_digest,
  );
});

test('different repository identity derives disjoint physical capabilities',()=>{
  assert.equal(
    deriveCapabilityRelation(
      status('success',{repository_id:123}),
      status('failure',{repository_id:456}),
    ).kind,
    'parallel-disjoint',
  );
});

test('different exact commit derives disjoint physical capabilities',()=>{
  assert.equal(
    deriveCapabilityRelation(
      status('success',{commit_sha:'a'.repeat(40)}),
      status('failure',{commit_sha:'b'.repeat(40)}),
    ).kind,
    'parallel-disjoint',
  );
});

test('different normalized context derives disjoint physical capabilities',()=>{
  assert.equal(
    deriveCapabilityRelation(
      status('success',{context:'overcenter/build'}),
      status('failure',{context:'overcenter/test'}),
    ).kind,
    'parallel-disjoint',
  );
});

test('same coordinate and same settlement-equivalence witness derives unordered-safe overlap',()=>{
  const relation=deriveCapabilityRelation(
    status('success',{context:'overcenter/Build'}),
    status('success',{context:'overcenter/build'}),
  );
  assert.equal(relation.kind,'parallel-settlement-equivalent');
});

test('same coordinate and incompatible desired state derives ordering requirement',()=>{
  const relation=deriveCapabilityRelation(
    status('success',{context:'overcenter/Build'}),
    status('failure',{context:'overcenter/build'}),
  );
  assert.equal(relation.kind,'ordered-conflict');
});

test('matching resource and operation are insufficient without matching witness identity',()=>{
  const left:MutationCapabilityFootprint={
    physical_resource:'provider:resource',
    semantic_operation:'same',
    settlement_equivalence_witness_digest:'a'.repeat(64),
  };
  const right:MutationCapabilityFootprint={
    physical_resource:'provider:resource',
    semantic_operation:'same',
    settlement_equivalence_witness_digest:'b'.repeat(64),
  };
  assert.equal(classifyCapabilityRelation(left,right).kind,'ordered-conflict');
});

test('unknown provider effect semantics fail closed for concurrency derivation',()=>{
  assert.equal(
    deriveCapabilityRelation(file('/tmp/a'),file('/tmp/b')).kind,
    'unknown',
  );
});

test('derived disjoint relation agrees with admission accepting unordered effects',()=>{
  const left=status('success',{context:'overcenter/a'});
  const right=status('failure',{context:'overcenter/b'});
  assert.equal(deriveCapabilityRelation(left,right).kind,'parallel-disjoint');
  assert.doesNotThrow(()=>validateAdmission(state(left,right)));
});

test('derived settlement-equivalent overlap agrees with admission accepting same-contract identical effects',()=>{
  const left=status('success',{context:'overcenter/Build'});
  const right=status('success',{context:'overcenter/build'});
  assert.equal(
    deriveCapabilityRelation(left,right).kind,
    'parallel-settlement-equivalent',
  );
  assert.doesNotThrow(()=>validateAdmission(state(left,right)));
});

test('derived incompatible overlap agrees with admission rejecting unordered effects',()=>{
  const left=status('success',{context:'overcenter/Build'});
  const right=status('failure',{context:'overcenter/build'});
  assert.equal(deriveCapabilityRelation(left,right).kind,'ordered-conflict');
  assert.throws(
    ()=>validateAdmission(state(left,right)),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('cross-verifier overlap derives conflict and admission now rejects it',()=>{
  const left=status('success');
  const right=statusV2('owner/repo');
  assert.equal(deriveCapabilityRelation(left,right).kind,'ordered-conflict');
  assert.throws(
    ()=>validateAdmission(state(left,right)),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('derived incompatible overlap agrees with admission accepting an explicit order',()=>{
  const left=status('success',{context:'overcenter/Build'});
  const right=status('failure',{context:'overcenter/build'});
  assert.equal(deriveCapabilityRelation(left,right).kind,'ordered-conflict');
  assert.doesNotThrow(()=>validateAdmission(state(left,right,true)));
});
