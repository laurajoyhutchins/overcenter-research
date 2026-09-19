import assert from 'node:assert/strict';
import test from 'node:test';
import type { Postcondition } from '../../src/model.ts';
import type { State } from '../../src/facts.ts';
import { validateAdmission } from '../../src/admission.ts';
import {
  certificatesAuthorizeUnorderedOverlap,
  issueEffectEquivalenceCertificate,
  validateEffectEquivalenceCertificate,
  type EffectEquivalenceCertificate,
} from './certificate.ts';

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
      alpha:{id:'alpha',dependencies:[],packet:{},postcondition:left},
      beta:{id:'beta',dependencies:[],packet:{},postcondition:right},
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };
}

function clone(
  certificate:EffectEquivalenceCertificate,
):EffectEquivalenceCertificate {
  return structuredClone(certificate);
}

test('certificate binds provider contracts, resource, operation, and semantics digests',()=>{
  const certificate=issueEffectEquivalenceCertificate(statusV1());
  assert.ok(certificate);
  assert.equal(certificate.provider,'github');
  assert.equal(certificate.verifier_contract,'github-commit-status/v1');
  assert.equal(certificate.coordinate_contract,'github-commit-status-coordinate/v1');
  assert.equal(certificate.observation_contract,'github-commit-status-observation/v1');
  assert.equal(certificate.operation_class,'github-commit-status/set-state/v1');
  assert.match(certificate.resource,/^github-status:123:/);
  assert.equal(certificate.operation,'success');
  assert.equal(certificate.equivalence_class,'same-desired-under-overcenter-settlement');
  assert.match(certificate.effect_semantics_digest,/^[0-9a-f]{64}$/);
  assert.match(certificate.settlement_semantics_digest,/^[0-9a-f]{64}$/);
  assert.match(certificate.certificate_digest,/^[0-9a-f]{64}$/);
});

test('same provider contract, canonical coordinate, and operation authorize unordered overlap',()=>{
  const left=statusV1('success',{context:'overcenter/Build'});
  const right=statusV1('success',{context:'overcenter/build'});
  const leftCertificate=issueEffectEquivalenceCertificate(left);
  const rightCertificate=issueEffectEquivalenceCertificate(right);
  assert.ok(leftCertificate);
  assert.ok(rightCertificate);
  assert.equal(
    certificatesAuthorizeUnorderedOverlap(
      left,leftCertificate,right,rightCertificate,
    ),
    true,
  );
});

test('repository rename remains equivalent within GitHub v2 because stable id defines the coordinate',()=>{
  const left=statusV2('success','owner/old-name');
  const right=statusV2('success','owner/new-name');
  const leftCertificate=issueEffectEquivalenceCertificate(left);
  const rightCertificate=issueEffectEquivalenceCertificate(right);
  assert.ok(leftCertificate);
  assert.ok(rightCertificate);
  assert.equal(leftCertificate.resource,rightCertificate.resource);
  assert.equal(
    certificatesAuthorizeUnorderedOverlap(
      left,leftCertificate,right,rightCertificate,
    ),
    true,
  );
});

test('changing repository identity invalidates the old certificate',()=>{
  const original=statusV1();
  const certificate=issueEffectEquivalenceCertificate(original);
  assert.ok(certificate);
  const changed=statusV1('success',{repository_id:456});
  assert.equal(validateEffectEquivalenceCertificate(changed,certificate),false);
});

test('changing exact commit invalidates the old certificate',()=>{
  const original=statusV1();
  const certificate=issueEffectEquivalenceCertificate(original);
  assert.ok(certificate);
  const changed=statusV1('success',{commit_sha:'b'.repeat(40)});
  assert.equal(validateEffectEquivalenceCertificate(changed,certificate),false);
});

test('changing normalized context invalidates the old certificate',()=>{
  const original=statusV1();
  const certificate=issueEffectEquivalenceCertificate(original);
  assert.ok(certificate);
  const changed=statusV1('success',{context:'overcenter/test'});
  assert.equal(validateEffectEquivalenceCertificate(changed,certificate),false);
});

test('changing desired operation invalidates the old certificate',()=>{
  const original=statusV1('success');
  const certificate=issueEffectEquivalenceCertificate(original);
  assert.ok(certificate);
  assert.equal(
    validateEffectEquivalenceCertificate(statusV1('failure'),certificate),
    false,
  );
});

test('tampered resource is rejected even when certificate digest is left untouched',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered=clone(certificate);
  tampered.resource='github-status:forged';
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered operation is rejected even when certificate digest is left untouched',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered=clone(certificate);
  tampered.operation='failure';
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered verifier contract is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered=clone(certificate);
  tampered.verifier_contract='github-commit-status/v2';
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered coordinate contract is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered={
    ...certificate,
    coordinate_contract:'forged-coordinate/v9',
  } as unknown as EffectEquivalenceCertificate;
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered observation contract is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered={
    ...certificate,
    observation_contract:'github-commit-status-observation/v2',
  } as EffectEquivalenceCertificate;
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered operation class is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered={
    ...certificate,
    operation_class:'forged-operation/v9',
  } as unknown as EffectEquivalenceCertificate;
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered issuer contract is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered={
    ...certificate,
    issuer_contract:'forged/issuer/v9',
  } as unknown as EffectEquivalenceCertificate;
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('tampered certificate digest is rejected',()=>{
  const postcondition=statusV1();
  const certificate=issueEffectEquivalenceCertificate(postcondition);
  assert.ok(certificate);
  const tampered=clone(certificate);
  tampered.certificate_digest='0'.repeat(64);
  assert.equal(validateEffectEquivalenceCertificate(postcondition,tampered),false);
});

test('different desired operations cannot authorize unordered overlap',()=>{
  const left=statusV1('success');
  const right=statusV1('failure');
  const leftCertificate=issueEffectEquivalenceCertificate(left);
  const rightCertificate=issueEffectEquivalenceCertificate(right);
  assert.ok(leftCertificate);
  assert.ok(rightCertificate);
  assert.equal(
    certificatesAuthorizeUnorderedOverlap(
      left,leftCertificate,right,rightCertificate,
    ),
    false,
  );
});

test('cross-verifier-version overlap requires an explicit bridge certificate',()=>{
  const left=statusV1('success');
  const right=statusV2('success');
  const leftCertificate=issueEffectEquivalenceCertificate(left);
  const rightCertificate=issueEffectEquivalenceCertificate(right);
  assert.ok(leftCertificate);
  assert.ok(rightCertificate);

  // Current boolean admission accepts this pair because effectSemantics emits
  // the same resource/desired tuple for v1 and v2.
  assert.doesNotThrow(()=>validateAdmission(state(left,right)));

  // Version-bound witnesses do not silently inherit that equivalence.
  assert.notEqual(
    leftCertificate.observation_contract,
    rightCertificate.observation_contract,
  );
  assert.equal(
    certificatesAuthorizeUnorderedOverlap(
      left,leftCertificate,right,rightCertificate,
    ),
    false,
  );
});

test('unsupported effect semantics cannot mint an equivalence certificate',()=>{
  const file:Postcondition={
    verifier:'file-content-equals/v1',
    path:'/tmp/effect',
    content:'value',
  };
  assert.equal(issueEffectEquivalenceCertificate(file),null);
});
