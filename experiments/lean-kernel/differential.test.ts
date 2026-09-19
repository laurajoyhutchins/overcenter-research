import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { sha256 } from '../../src/digest.ts';
import {
  localFileEnoentEvidence,
  type AbsenceEvidenceCertificate,
} from '../../src/evidence.ts';
import {
  RECEIPT_SCHEMA,
  type ReceiptFact,
} from '../../src/facts.ts';
import type {
  Obligation,
  Observation,
} from '../../src/model.ts';
import { projectReceipt } from '../../src/projection.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';
const verifierRevision='file-content-equals/v1@semantics-1';

function tsDisposition(work:Obligation,observed:Observation):string {
  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run',
    obligation_id:work.id,
    claimed_revision:'revision',
    claim_commit:'claim',
    execution_generation:1,
    execution_authority_commit:'claim',
    kind:'observation',
    observed,
    settled_at:'2026-09-19T00:00:00.000Z',
  };
  return projectReceipt(fact,work).disposition;
}

function data(value:unknown):Record<string,unknown> {
  assert.ok(value && typeof value==='object' && !Array.isArray(value));
  return value as Record<string,unknown>;
}

function leanAbsence(evidence:AbsenceEvidenceCertificate|undefined):unknown {
  if (!evidence) return null;
  assert.equal(evidence.kind,'local-file-enoent/v1');
  const subject=data(evidence.subject);
  const scope=data(evidence.scope);
  const coordinate=data(scope.coordinate);
  const completeness=data(evidence.completeness);
  const provenance=data(evidence.provenance);
  return {
    kind:evidence.kind,
    subject_coordinate:subject.path,
    scope_coordinate:coordinate.path,
    snapshot_is_null:evidence.snapshot===null,
    completeness_kind:completeness.kind,
    completeness_result:completeness.result,
    provenance_adapter:provenance.adapter,
    provenance_operation:provenance.operation,
    provenance_error_code:provenance.error_code,
  };
}

function leanDisposition(
  work:Obligation,
  observed:Observation,
):string {
  assert.equal(work.postcondition.verifier,'file-content-equals/v1');
  if (work.postcondition.verifier!=='file-content-equals/v1') {
    throw new Error('WRONG_VERIFIER');
  }
  const request={
    command:'settle',
    postcondition:{
      family:'file-content',
      verifier_revision:verifierRevision,
      coordinate:work.postcondition.path,
      expected:sha256(work.postcondition.content),
    },
    observation:{
      family:'file-content',
      verifier_revision:verifierRevision,
      coordinate:observed.path,
      certainty:observed.mutation_certainty,
      actual:observed.actual_sha256??null,
      absence:leanAbsence(observed.absence_evidence),
    },
  };
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  const response=JSON.parse(stdout) as {
    schema:string;
    disposition:string;
  };
  assert.equal(response.schema,'overcenter-lean-kernel/v1');
  return response.disposition;
}

function fixture():Obligation {
  return {
    id:'file',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      content:'A',
    },
  };
}

test('Lean and TypeScript agree on local-file settlement decisions',()=>{
  const work=fixture();
  const expected=sha256('A');

  const goodAbsence=localFileEnoentEvidence('/provider/a');

  const badCompleteness=structuredClone(goodAbsence);
  badCompleteness.completeness={
    kind:'direct-coordinate-read',
    result:'EACCES',
  };

  const badProvenance=structuredClone(goodAbsence);
  badProvenance.provenance={
    adapter:'node:fs',
    operation:'existsSync',
    error_code:'ENOENT',
  };

  const cases:Array<{name:string;observed:Observation}>=[
    {
      name:'exact present',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        actual_sha256:expected,
        mutation_certainty:'present',
      },
    },
    {
      name:'wrong content',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        actual_sha256:sha256('B'),
        mutation_certainty:'present',
      },
    },
    {
      name:'uncertain read',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        actual_sha256:expected,
        mutation_certainty:'uncertain',
      },
    },
    {
      name:'authoritative ENOENT',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        mutation_certainty:'absent',
        absence_evidence:goodAbsence,
      },
    },
    {
      name:'wrong completeness result',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        mutation_certainty:'absent',
        absence_evidence:badCompleteness,
      },
    },
    {
      name:'wrong provenance operation',
      observed:{
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:expected,
        mutation_certainty:'absent',
        absence_evidence:badProvenance,
      },
    },
  ];

  for (const candidate of cases) {
    assert.equal(
      leanDisposition(work,candidate.observed),
      tsDisposition(work,candidate.observed),
      candidate.name,
    );
  }
});

test('serialized kernel boundary fails closed on malformed and unknown commands',()=>{
  assert.throws(
    ()=>execFileSync(kernel,[],{
      input:'{not-json',
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    }),
  );

  assert.throws(
    ()=>execFileSync(kernel,[],{
      input:JSON.stringify({command:'believe-worker'}),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    }),
  );
});
