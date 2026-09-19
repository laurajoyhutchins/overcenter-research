import assert from 'node:assert/strict';
import test from 'node:test';
import type { Postcondition } from '../../src/model.ts';
import type { State } from '../../src/facts.ts';
import { validateAdmission } from '../../src/admission.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';
import {
  issueSettlementEquivalenceWitness,
  validateSettlementEquivalenceWitness,
  witnessesAuthorizeUnorderedOverlap,
  type SettlementEquivalenceWitness,
} from './witness.ts';

function statusV1(
  expected_state:'error'|'failure'|'pending'|'success'='success',
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
  expected_state:'error'|'failure'|'pending'|'success'='success',
  repository_full_name='owner/repo',
):Postcondition {
  return {
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:123,
    repository_full_name,
    commit_sha:'a'.repeat(40),
    context:'overcenter/Build',
    expected_state,
  };
}

function state(left:Postcondition,right:Postcondition):State {
  return {
    obligations:{
      alpha:{
        id:'alpha',
        dependencies:[],
        packet:{},
        effect_authority:githubCommitStatusEffectAuthority(),
        postcondition:left,
      },
      beta:{
        id:'beta',
        dependencies:[],
        packet:{},
        effect_authority:githubCommitStatusEffectAuthority(),
        postcondition:right,
      },
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };
}

function clone(
  witness:SettlementEquivalenceWitness,
):SettlementEquivalenceWitness {
  return structuredClone(witness);
}

test('witness binds exact observation and settlement claim',()=>{
  const witness=issueSettlementEquivalenceWitness(statusV1());
  assert.ok(witness);
  assert.equal(witness.schema,'overcenter-settlement-equivalence-witness-v1');
  assert.equal(
    witness.issuer_contract,
    'overcenter/provider-settlement-equivalence-issuer/v1',
  );
  assert.equal(witness.provider,'github');
  assert.equal(witness.verifier_contract,'github-commit-status/v1');
  assert.equal(witness.coordinate_contract,'github-commit-status-coordinate/v1');
  assert.equal(witness.observation_contract,'github-commit-status-observation/v1');
  assert.equal(
    witness.operation_class,
    'github-rest:create-commit-status@2026-03-10',
  );
  assert.match(witness.provider_contract_digest,/^[0-9a-f]{64}$/);
  assert.match(witness.resource,/^github-status:123:/);
  assert.equal(witness.operation,'success');
  assert.equal(
    witness.equivalence_class,
    'same-project-truth-under-observation-and-settlement',
  );
  assert.match(witness.effect_semantics_digest,/^[0-9a-f]{64}$/);
  assert.match(witness.settlement_semantics_digest,/^[0-9a-f]{64}$/);
  assert.match(witness.witness_digest,/^[0-9a-f]{64}$/);
});

test('same provider contract, coordinate, and desired state authorize unordered overlap',()=>{
  const left=statusV1('success',{context:'overcenter/Build'});
  const right=statusV1('success',{context:'overcenter/build'});
  assert.equal(witnessesAuthorizeUnorderedOverlap(left,right),true);
});

test('repository rename remains equivalent within v2 because stable id defines coordinate',()=>{
  const left=statusV2('success','owner/old-name');
  const right=statusV2('success','owner/new-name');
  const leftWitness=issueSettlementEquivalenceWitness(left);
  const rightWitness=issueSettlementEquivalenceWitness(right);
  assert.ok(leftWitness);
  assert.ok(rightWitness);
  assert.equal(leftWitness.resource,rightWitness.resource);
  assert.equal(leftWitness.witness_digest,rightWitness.witness_digest);
  assert.equal(witnessesAuthorizeUnorderedOverlap(left,right),true);
});

test('semantic coordinate or desired-state changes invalidate an old witness',()=>{
  const original=statusV1();
  const witness=issueSettlementEquivalenceWitness(original);
  assert.ok(witness);

  for (const changed of [
    statusV1('success',{repository_id:456}),
    statusV1('success',{commit_sha:'b'.repeat(40)}),
    statusV1('success',{context:'overcenter/test'}),
    statusV1('failure'),
  ]) {
    assert.equal(
      validateSettlementEquivalenceWitness(changed,witness),
      false,
    );
  }
});

test('tampered witness fields are rejected by re-derivation',()=>{
  const postcondition=statusV1();
  const witness=issueSettlementEquivalenceWitness(postcondition);
  assert.ok(witness);

  const mutations:Array<(w:SettlementEquivalenceWitness)=>void>=[
    w=>{ w.resource='github-status:forged'; },
    w=>{ w.operation='failure'; },
    w=>{ w.verifier_contract='github-commit-status/v2'; },
    w=>{ w.coordinate_contract='forged-coordinate/v9'; },
    w=>{ w.observation_contract='github-commit-status-observation/v2'; },
    w=>{ w.operation_class='forged-operation/v9'; },
    w=>{ w.provider_contract_digest='0'.repeat(64); },
    w=>{ w.witness_digest='0'.repeat(64); },
  ];

  for (const mutate of mutations) {
    const forged=clone(witness);
    mutate(forged);
    assert.equal(
      validateSettlementEquivalenceWitness(postcondition,forged),
      false,
    );
  }

  const forgedIssuer={
    ...witness,
    issuer_contract:'forged/issuer/v9',
  } as unknown as SettlementEquivalenceWitness;
  assert.equal(
    validateSettlementEquivalenceWitness(postcondition,forgedIssuer),
    false,
  );
});

test('different desired states cannot authorize unordered overlap',()=>{
  assert.equal(
    witnessesAuthorizeUnorderedOverlap(
      statusV1('success'),
      statusV1('failure'),
    ),
    false,
  );
});

test('cross-verifier overlap requires explicit bridge evidence',()=>{
  const left=statusV1('success');
  const right=statusV2('success');

  assert.equal(witnessesAuthorizeUnorderedOverlap(left,right),false);
  assert.throws(
    ()=>validateAdmission(state(left,right)),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('unsupported effect semantics cannot mint settlement-equivalence evidence',()=>{
  const file:Postcondition={
    verifier:'file-content-equals/v1',
    path:'/tmp/effect',
    content:'value',
  };
  assert.equal(issueSettlementEquivalenceWitness(file),null);
});
