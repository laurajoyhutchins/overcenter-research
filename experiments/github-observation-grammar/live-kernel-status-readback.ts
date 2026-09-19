import assert from 'node:assert/strict';
import { observePostcondition } from '../../src/observation/observe.ts';
import {
  GITHUB_OPENAPI_SHA256,
} from '../../src/providers/github/certified-status.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const repositoryId=1354872053;
const repositoryFullName='laurajoyhutchins/overcenter-research';
const commitSha='b91ac6c4e64f72b83c6a8d8caa78e9482037a2d1';
const context='overcenter/concurrency/35373921130/1/alpha';

const positive=observePostcondition({
  verifier:'github-commit-status/v2',
  provider:'github',
  repository_id:repositoryId,
  repository_full_name:repositoryFullName,
  commit_sha:commitSha,
  context,
  expected_state:'success',
},{githubToken:token});

assert.equal(positive.mutation_certainty,'present');
assert.equal(positive.actual_state,'success');
assert.equal(positive.repository_id,repositoryId);
assert.equal(positive.repository_full_name,repositoryFullName);
const positiveEvidence=positive.provider_evidence as Record<string,unknown>;
assert.equal(positiveEvidence.schema_sha256,GITHUB_OPENAPI_SHA256);
assert.equal(positiveEvidence.status_operation_id,'repos/list-commit-statuses-for-ref');
const repositoryEvidence=positiveEvidence.repository as Record<string,unknown>;
assert.equal(repositoryEvidence.operation_id,'repos/get');
assert.equal(repositoryEvidence.canonical_full_name,repositoryFullName);

const missingContext=`overcenter/certified-observation/missing/${process.env.GITHUB_RUN_ID ?? 'run'}`;
const missing=observePostcondition({
  verifier:'github-commit-status/v2',
  provider:'github',
  repository_id:repositoryId,
  repository_full_name:repositoryFullName,
  commit_sha:commitSha,
  context:missingContext,
  expected_state:'success',
},{githubToken:token});

assert.equal(missing.mutation_certainty,'uncertain');
assert.equal(missing.absence_evidence,undefined);
assert.equal(missing.observation_error,'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');

console.log(JSON.stringify({
  positive:{
    repository_id:positive.repository_id,
    repository_full_name:positive.repository_full_name,
    repository_node_id:repositoryEvidence.node_id,
    repository_operation:repositoryEvidence.operation_id,
    commit_sha:positive.commit_sha,
    context:positive.context,
    actual_state:positive.actual_state,
    mutation_certainty:positive.mutation_certainty,
    schema_sha256:positiveEvidence.schema_sha256,
    status_operation:positiveEvidence.status_operation_id,
    pages:(positiveEvidence.pages as unknown[]).length,
  },
  missing:{
    context:missing.context,
    mutation_certainty:missing.mutation_certainty,
    absence_evidence:missing.absence_evidence,
    reason:missing.observation_error,
  },
},null,2));
