import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABSENCE_EVIDENCE_SCHEMA,
  localFileEnoentEvidence,
  localFileEnoentEvidenceMatches,
  validateAbsenceEvidenceEnvelope,
} from '../src/observation/evidence.ts';

test('local file ENOENT evidence carries subject, scope, completeness, and provenance',()=>{
  const evidence=localFileEnoentEvidence('/provider/a');

  assert.equal(evidence.schema,ABSENCE_EVIDENCE_SCHEMA);
  assert.equal(evidence.kind,'local-file-enoent/v1');
  assert.deepEqual(evidence.subject,{
    kind:'file-path',
    path:'/provider/a',
  });
  assert.deepEqual(evidence.scope,{
    kind:'exact-coordinate',
    coordinate:{
      kind:'file-path',
      path:'/provider/a',
    },
  });
  assert.equal(evidence.snapshot,null);
  assert.deepEqual(evidence.completeness,{
    kind:'direct-coordinate-read',
    result:'ENOENT',
  });
  assert.deepEqual(evidence.provenance,{
    adapter:'node:fs',
    operation:'readFileSync',
    error_code:'ENOENT',
  });
  assert.doesNotThrow(()=>validateAbsenceEvidenceEnvelope(evidence));
  assert.equal(localFileEnoentEvidenceMatches(evidence,'/provider/a'),true);
  assert.equal(localFileEnoentEvidenceMatches(evidence,'/provider/b'),false);
});

test('tampered local absence evidence fails closed',()=>{
  const original=localFileEnoentEvidence('/provider/a');

  const badScope=structuredClone(original);
  badScope.scope={kind:'exact-coordinate',coordinate:{kind:'file-path',path:'/provider/b'}};
  assert.equal(localFileEnoentEvidenceMatches(badScope,'/provider/a'),false);

  const badCompleteness=structuredClone(original);
  badCompleteness.completeness={kind:'direct-coordinate-read',result:'EACCES'};
  assert.equal(localFileEnoentEvidenceMatches(badCompleteness,'/provider/a'),false);

  const badProvenance=structuredClone(original);
  badProvenance.provenance={adapter:'node:fs',operation:'readFileSync',error_code:'UNKNOWN'};
  assert.equal(localFileEnoentEvidenceMatches(badProvenance,'/provider/a'),false);
});

test('envelope can carry Kubernetes-style snapshot provenance without granting it authority',()=>{
  const evidence={
    schema:ABSENCE_EVIDENCE_SCHEMA,
    kind:'kubernetes-complete-list-absence/v1',
    subject:{
      api_group:'',
      resource:'configmaps',
      namespace:'proof',
      name:'missing',
    },
    scope:{
      api_group:'',
      resource:'configmaps',
      namespace:'proof',
    },
    snapshot:{
      resource_version:'489',
    },
    completeness:{
      kind:'complete-list',
      page_count:3,
      terminal_continue:'',
      page_chain_digest:'sha256:example',
    },
    provenance:{
      provider:'kubernetes',
      contract:'openapi-v3',
      structural_certificate_digests:[
        'sha256:page-1',
        'sha256:page-2',
        'sha256:page-3',
      ],
    },
  };

  assert.doesNotThrow(()=>validateAbsenceEvidenceEnvelope(evidence));
  assert.equal(localFileEnoentEvidenceMatches(evidence,'/provider/a'),false);
});


test('absence envelope rejects unknown outer fields',()=>{
  const evidence={
    ...localFileEnoentEvidence('/provider/a'),
    surprise:true,
  };
  assert.throws(
    ()=>validateAbsenceEvidenceEnvelope(evidence),
    /INVALID_ABSENCE_EVIDENCE_SHAPE/,
  );
});

test('local absence authority rejects unknown nested certificate fields',()=>{
  const evidence=localFileEnoentEvidence('/provider/a');
  evidence.provenance={
    ...evidence.provenance,
    surprise:true,
  };
  assert.equal(localFileEnoentEvidenceMatches(evidence,'/provider/a'),false);
});
