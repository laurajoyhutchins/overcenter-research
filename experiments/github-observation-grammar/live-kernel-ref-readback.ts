import assert from 'node:assert/strict';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../../src/facts.ts';
import type { GitHubRefTargetPostcondition, Obligation } from '../../src/model.ts';
import { observePostcondition } from '../../src/observation.ts';
import { projectReceipt } from '../../src/projection.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const token=required('GITHUB_TOKEN');
const repositoryId=Number(required('GITHUB_REPOSITORY_ID'));
if (!Number.isSafeInteger(repositoryId) || repositoryId<=0) {
  throw new Error('GITHUB_REPOSITORY_ID_INVALID');
}
const sourceRef=required('SOURCE_REF');
const sourceSha=required('SOURCE_SHA').toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID');

const ref=`heads/${sourceRef}`;

function pc(targetSha:string,coordinate=ref):GitHubRefTargetPostcondition {
  return {
    verifier:'github-ref-target/v1',
    provider:'github',
    repository_id:repositoryId,
    ref:coordinate,
    target_sha:targetSha,
  };
}

function disposition(
  postcondition:GitHubRefTargetPostcondition,
  observed:ReturnType<typeof observePostcondition>,
) {
  const work:Obligation={
    id:'live-ref-proof',
    dependencies:[],
    packet:{},
    postcondition,
  };
  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:process.env.GITHUB_RUN_ID ?? 'live',
    obligation_id:work.id,
    claimed_revision:sourceSha,
    claim_commit:sourceSha,
    kind:'observation',
    observed,
    settled_at:new Date().toISOString(),
  };
  return projectReceipt(fact,work).disposition;
}

const exactPc=pc(sourceSha);
const exact=observePostcondition(exactPc,{githubToken:token});
assert.equal(exact.mutation_certainty,'present');
assert.equal(exact.actual_target_sha?.toLowerCase(),sourceSha);
assert.equal(disposition(exactPc,exact),'DONE');

const differentSha=(sourceSha==='0'.repeat(sourceSha.length)?'f':'0').repeat(sourceSha.length);
const mismatchPc=pc(differentSha);
const mismatch=observePostcondition(mismatchPc,{githubToken:token});
assert.equal(mismatch.mutation_certainty,'absent');
assert.equal(mismatch.actual_target_sha?.toLowerCase(),sourceSha);
assert.equal(disposition(mismatchPc,mismatch),'READY');

const missingRef=`heads/overcenter-missing/${process.env.GITHUB_RUN_ID ?? 'run'}`;
const missingPc=pc(sourceSha,missingRef);
const missing=observePostcondition(missingPc,{githubToken:token});
assert.equal(missing.mutation_certainty,'uncertain');
assert.equal(missing.negative_evidence_authoritative,false);
assert.equal(disposition(missingPc,missing),'RECOVERY_REQUIRED');

console.log(JSON.stringify({
  exact:{
    repository_id:exact.repository_id,
    repository_full_name:exact.repository_full_name,
    ref:exact.ref,
    target_sha:exact.target_sha,
    actual_target_sha:exact.actual_target_sha,
    mutation_certainty:exact.mutation_certainty,
    disposition:'DONE',
  },
  mismatch:{
    ref:mismatch.ref,
    expected_target_sha:mismatch.target_sha,
    actual_target_sha:mismatch.actual_target_sha,
    mutation_certainty:mismatch.mutation_certainty,
    disposition:'READY',
  },
  missing:{
    ref:missing.ref,
    mutation_certainty:missing.mutation_certainty,
    negative_evidence_authoritative:missing.negative_evidence_authoritative,
    observation_error:missing.observation_error,
    disposition:'RECOVERY_REQUIRED',
  },
},null,2));
