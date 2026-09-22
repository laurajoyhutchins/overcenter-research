import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {observe} from './observe.mjs';
import {evaluateRefinement} from './score.mjs';

const candidateBytes=readFileSync(new URL('./round-one-candidate.json',import.meta.url));
const provenanceBytes=readFileSync(new URL('./round-one-provenance.json',import.meta.url));
const roundOne=JSON.parse(candidateBytes);
const roundOneProvenance=JSON.parse(provenanceBytes);
const roundOneSource=JSON.parse(readFileSync(new URL('./round-one-source.json',import.meta.url),'utf8'));

const repaired={
  schema:'overcenter-recovery-search-proposals/v1',
  proposals:[
    {case_id:'exact-litware',kind:'search',fields:{operation:'payment.capture',resource:'merchant:litware'}},
    {case_id:'northwind-payment',kind:'search',fields:{operation:'payment.capture',resource:'merchant:northwind-traders',amount:'184.27'}},
    {case_id:'analytics-preview-vm',kind:'search',fields:{operation:'compute.instances.insert',resource:'vm:analytics-preview-03',region:'us-west1'}},
    {case_id:'acme-kim-mail',kind:'search',fields:{operation:'mail.send',resource:'recipient:klee@acme.example'}},
    {case_id:'checkout-east-canary',kind:'search',fields:{operation:'deploy.release',resource:'service:checkout-api-canary-e1',artifact:'7f3d9a'}},
    {case_id:'contoso-eu-archive',kind:'search',fields:{operation:'storage.objects.create',resource:'bucket:contoso-invoices-eu-primary'}},
    {case_id:'maya-finance-access',kind:'search',fields:{operation:'iam.grant',resource:'dataset:finance_2026',principal:'user:mchen-ext@vendor.example'}},
    {case_id:'missing-physical-receipt',kind:'unresolved'},
  ],
};

test('round one is the exact frozen #237 candidate artifact',()=>{
  const sha=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(roundOneSource.source_pr,237);
  assert.equal(roundOneSource.source_head_sha,'88c90ab73fdc49facbb48b014cd543c65d22b2a0');
  assert.equal(roundOneSource.workflow_run_id,35694479360);
  assert.equal(sha(candidateBytes),roundOneSource.candidate_sha256);
  assert.equal(sha(candidateBytes),roundOneProvenance.candidate_sha256);
  assert.equal(sha(provenanceBytes),roundOneSource.provenance_sha256);
  assert.equal(roundOneProvenance.model_id,'gemini-3.8-flash');
  assert.equal(roundOneProvenance.overcenter_authority_present,false);
  assert.equal(roundOneProvenance.provider_mutation_authority_present,false);
});

test('sanitized observations expose cardinality but not settlement evidence',()=>{
  const result=observe(roundOne);
  const keys=[];
  const visit=value=>{
    if (!value || typeof value!=='object') return;
    for (const [key,child] of Object.entries(value)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(result);
  for (const forbidden of ['matched_record','effect_digest','expected_effect_digest','certainty','resolved','reason','outcome']) {
    assert.equal(keys.includes(forbidden),false,forbidden);
  }
  assert.equal(result.observations.find(x=>x.case_id==='northwind-payment').cardinality,'zero');
  assert.equal(result.observations.find(x=>x.case_id==='checkout-east-canary').cardinality,'one');
  assert.equal(result.observations.find(x=>x.case_id==='missing-physical-receipt').cardinality,'not-searched');
});

test('a unique wrong record is still reported only as cardinality one',()=>{
  const candidate={
    schema:'overcenter-recovery-search-proposals/v1',
    proposals:[
      {case_id:'northwind-payment',kind:'search',fields:{operation:'payment.capture',resource:'merchant:northwind-logistics',amount:'184.27'}},
      ...roundOne.proposals.filter(x=>x.case_id!=='northwind-payment'),
    ],
  };
  const result=observe(candidate);
  assert.equal(result.observations.find(x=>x.case_id==='northwind-payment').cardinality,'one');
});

test('cumulative scoring preserves first-round evidence and measures refinement separately',()=>{
  const result=evaluateRefinement(roundOne,repaired);
  assert.equal(result.deterministic_baseline_resolved,4);
  assert.equal(result.round_one_resolved,3);
  assert.equal(result.cumulative_two_round_resolved,7);
  assert.equal(result.refinement_gain,4);
  assert.equal(result.baseline_gain,3);
  assert.equal(result.false_certainty,0);
  assert.equal(result.permanent_uncertainty_violations,0);
  assert.equal(result.mechanism_supported,true);
  assert.equal(result.role_supported,true);
});

test('a second round cannot erase an effect-bound first-round recovery',()=>{
  const unresolved={
    schema:'overcenter-recovery-search-proposals/v1',
    proposals:roundOne.proposals.map(item=>({case_id:item.case_id,kind:'unresolved'})),
  };
  const result=evaluateRefinement(repaired,unresolved);
  assert.equal(result.round_two_resolved,0);
  assert.equal(result.cumulative_two_round_resolved,7);
});
