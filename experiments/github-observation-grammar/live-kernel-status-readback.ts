import assert from 'node:assert/strict';
import { observePostcondition } from '../../src/observation.ts';
import { GITHUB_OPENAPI_SHA256 } from '../../src/providers/github-contract.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const repositoryId=1354872053;
const commitSha='b91ac6c4e64f72b83c6a8d8caa78e9482037a2d1';
const context='overcenter/concurrency/35373921130/1/alpha';

const positive=observePostcondition({
  verifier:'github-commit-status/v1',
  provider:'github',
  repository_id:repositoryId,
  commit_sha:commitSha,
  context,
  expected_state:'success',
},{githubToken:token});

assert.equal(positive.mutation_certainty,'present');
assert.equal(positive.actual_state,'success');
assert.deepEqual(positive.legacy_interpretation,{mutation_certainty:'present'});
const positiveEvidence=positive.provider_evidence as Record<string,unknown>;
assert.equal(positiveEvidence.schema_sha256,GITHUB_OPENAPI_SHA256);
assert.equal(positiveEvidence.operation_id,'repos/list-commit-statuses-for-ref');

const missingContext=`overcenter/certified-observation/missing/${process.env.GITHUB_RUN_ID ?? 'run'}`;
const missing=observePostcondition({
  verifier:'github-commit-status/v1',
  provider:'github',
  repository_id:repositoryId,
  commit_sha:commitSha,
  context:missingContext,
  expected_state:'success',
},{githubToken:token});

assert.equal(missing.mutation_certainty,'uncertain');
assert.equal(missing.negative_evidence_authoritative,false);
assert.equal(missing.observation_error,'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
assert.deepEqual(missing.legacy_interpretation,{mutation_certainty:'absent'});

console.log(JSON.stringify({
  positive:{
    repository_id:positive.repository_id,
    repository_full_name:positive.repository_full_name,
    commit_sha:positive.commit_sha,
    context:positive.context,
    actual_state:positive.actual_state,
    mutation_certainty:positive.mutation_certainty,
    schema_sha256:positiveEvidence.schema_sha256,
    pages:(positiveEvidence.pages as unknown[]).length,
  },
  missing:{
    context:missing.context,
    mutation_certainty:missing.mutation_certainty,
    negative_evidence_authoritative:missing.negative_evidence_authoritative,
    reason:missing.observation_error,
    legacy_interpretation:missing.legacy_interpretation,
  },
},null,2));
