import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {join} from 'node:path';
import {contractPackage} from '../scripts/contract-package.mjs';

import {SettlementObservationSchema} from '../src/generated/settlement-observation-schema.ts';
import {
  assertSupportedStructuralSchema,
  structurallyMatches,
} from '../src/structural-schema.ts';
import {localFileEnoentEvidence} from '../src/evidence.ts';
import {validateObservationEnvelope} from '../src/observation.ts';

const document=JSON.parse(
  readFileSync(join(contractPackage('observation-evidence'),'schema.json'),'utf8'),
);

test('generated runtime structure is the production wire definition',()=>{
  assert.deepEqual(
    SettlementObservationSchema,
    document.$defs.SettlementObservation,
  );
  assert.doesNotThrow(()=>assertSupportedStructuralSchema(SettlementObservationSchema));
});

test('runtime structural validator remains fail closed',()=>{
  const valid={
    verifier:'github-commit-status/v2',
    mutation_certainty:'present',
    provider:'github',
    repository_id:1,
    repository_full_name:'owner/repo',
    commit_sha:'a'.repeat(40),
    context:'ci',
    expected_state:'success',
    actual_state:'success',
    provider_evidence:{opaque:true},
  };
  assert.doesNotThrow(()=>validateObservationEnvelope(valid));
  assert.throws(
    ()=>validateObservationEnvelope({...valid,observer_generation:1}),
    /OBSERVATION_INVALID/,
  );
  assert.throws(
    ()=>validateObservationEnvelope({...valid,verifier:'github-commit-status\/v1'}),
    /OBSERVATION_VERIFIER_INVALID/,
  );
  assert.throws(
    ()=>validateObservationEnvelope({...valid,repository_id:0}),
    /OBSERVATION_INVALID/,
  );
  assert.doesNotThrow(()=>validateObservationEnvelope({
    verifier:'file-content-equals/v1',
    mutation_certainty:'absent',
    path:'/tmp/x',
    absence_evidence:localFileEnoentEvidence('/tmp/x'),
  }));
});

test('schema mutations directly change deterministic structural admission',()=>{
  const base={
    verifier:'file-content-equals/v1',
    mutation_certainty:'present',
  };
  const added=structuredClone(SettlementObservationSchema);
  added.properties.observer_generation={type:'integer'};
  assert.equal(structurallyMatches(SettlementObservationSchema,{...base,observer_generation:1}),false);
  assert.equal(structurallyMatches(added,{...base,observer_generation:1}),true);

  const narrowed=structuredClone(SettlementObservationSchema);
  narrowed.properties.verifier.enum=['file-content-equals/v1'];
  assert.equal(
    structurallyMatches(narrowed,{
      verifier:'github-commit-status/v2',
      mutation_certainty:'present',
    }),
    false,
  );

  const bounded=structuredClone(SettlementObservationSchema);
  bounded.properties.repository_id.maximum=10;
  assert.equal(structurallyMatches(bounded,{...base,repository_id:11}),false);
});
