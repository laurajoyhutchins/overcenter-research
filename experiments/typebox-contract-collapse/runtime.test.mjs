import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import Schema from 'typebox/schema';

import {SettlementObservation} from './candidate.ts';
import {localFileEnoentEvidence} from '../../src/evidence.ts';
import {validateObservationEnvelope} from '../../src/observation.ts';

const contract=JSON.parse(
  readFileSync('contracts/observation-evidence-v1/schema.json','utf8'),
);
const current=contract.$defs.SettlementObservation;
const emitted=JSON.parse(JSON.stringify(SettlementObservation));

function compile(schema){
  return Schema.Compile({
    ...schema,
    $defs:{
      AbsenceEvidenceEnvelope:contract.$defs.AbsenceEvidenceEnvelope,
    },
  });
}

const validator=compile(emitted);

function acceptsExisting(value){
  try {
    validateObservationEnvelope(structuredClone(value));
    return true;
  } catch {
    return false;
  }
}

const base={
  verifier:'file-content-equals/v1',
  mutation_certainty:'present',
};

test('TypeBox emits the production SettlementObservation definition exactly',()=>{
  assert.deepEqual(emitted,current);
});

test('TypeBox runtime acceptance matches the current handwritten validator',()=>{
  const validAbsence=localFileEnoentEvidence('/tmp/typebox-contract-collapse');
  const cases=[
    base,
    {...base,path:'/tmp/a',expected_sha256:'a',actual_sha256:'b'},
    {
      verifier:'github-commit-status/v2',
      mutation_certainty:'present',
      provider:'github',
      repository_id:1,
      repository_full_name:'owner/repo',
      commit_sha:'abc',
      context:'ci',
      expected_state:'success',
      actual_state:'success',
      provider_evidence:{opaque:true},
    },
    {
      verifier:'file-content-equals/v1',
      mutation_certainty:'absent',
      absence_evidence:validAbsence,
    },
    {...base,unknown_field:true},
    {...base,verifier:'github-commit-status/v1'},
    {...base,mutation_certainty:'maybe'},
    {...base,provider:'gitlab'},
    {...base,path:42},
    {...base,repository_id:0},
    {...base,repository_id:1.5},
    {...base,repository_id:Number.MAX_SAFE_INTEGER+1},
    {...base,provider_evidence:null},
    {...base,provider_evidence:[]},
    {...base,absence_evidence:{}},
  ];

  for (const value of cases) {
    assert.equal(
      validator.Check(value),
      acceptsExisting(value),
      JSON.stringify(value),
    );
  }
});

test('one schema mutation changes runtime admission without another field inventory',()=>{
  const added=structuredClone(emitted);
  added.properties.observer_generation={type:'integer'};
  const addedValidator=compile(added);
  assert.equal(validator.Check({...base,observer_generation:1}),false);
  assert.equal(addedValidator.Check({...base,observer_generation:1}),true);

  const narrowed=structuredClone(emitted);
  narrowed.properties.verifier.enum=['file-content-equals/v1'];
  const narrowedValidator=compile(narrowed);
  assert.equal(
    validator.Check({
      verifier:'github-commit-status/v2',
      mutation_certainty:'present',
    }),
    true,
  );
  assert.equal(
    narrowedValidator.Check({
      verifier:'github-commit-status/v2',
      mutation_certainty:'present',
    }),
    false,
  );

  const bounded=structuredClone(emitted);
  bounded.properties.repository_id.maximum=10;
  const boundedValidator=compile(bounded);
  assert.equal(validator.Check({...base,repository_id:11}),true);
  assert.equal(boundedValidator.Check({...base,repository_id:11}),false);
});

test('report maintenance surface instead of crediting generated artifacts as authored truth',()=>{
  const lineCount=value=>value.trimEnd().split('\n').length;
  const linkml=readFileSync(
    'contracts/observation-evidence-v1/settlement-observation.linkml.yaml',
    'utf8',
  );
  const generator=readFileSync(
    'scripts/generate-settlement-observation-schema.mjs',
    'utf8',
  );
  const projectionTest=readFileSync(
    'test/linkml-production-contract.test.mjs',
    'utf8',
  );
  const model=readFileSync('src/model.ts','utf8');
  const observation=readFileSync('src/observation.ts','utf8');
  const candidate=readFileSync(
    'experiments/typebox-contract-collapse/candidate.ts',
    'utf8',
  );

  const interfaceStart=model.indexOf('export interface Observation {');
  const interfaceEnd=model.indexOf('\n}\n\nexport type Dependency',interfaceStart)+2;
  const validatorStart=observation.indexOf('export function validateObservationEnvelope(');
  const validatorEnd=observation.indexOf('\nfunction readLocalFile(',validatorStart);

  assert.ok(interfaceStart>=0 && interfaceEnd>interfaceStart);
  assert.ok(validatorStart>=0 && validatorEnd>validatorStart);

  const report={
    current_authored_structural_lines:
      lineCount(linkml)
      +lineCount(model.slice(interfaceStart,interfaceEnd))
      +lineCount(observation.slice(validatorStart,validatorEnd)),
    current_projection_machinery_lines:
      lineCount(generator)+lineCount(projectionTest),
    candidate_authored_structural_lines:lineCount(candidate),
    current_authored_manifestations:3,
    candidate_authored_manifestations:1,
  };
  console.log('TYPEBOX_MAINTENANCE_SURFACE '+JSON.stringify(report));

  assert.equal(report.current_authored_manifestations,3);
  assert.equal(report.candidate_authored_manifestations,1);
  assert.ok(
    report.candidate_authored_structural_lines
      < report.current_authored_structural_lines,
  );
});
