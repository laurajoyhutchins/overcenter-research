import assert from 'node:assert/strict';

import { GITHUB_OPENAPI_SHA256 } from '../../src/providers/github/contract.ts';
import {
  observeCertifiedGithubSemanticRead,
  type CertifiedGithubSemanticReadResult,
} from '../../src/providers/github/certified-read.ts';

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const sourceSha = process.env.SOURCE_SHA;
if (!sourceSha) throw new Error('SOURCE_SHA_REQUIRED');
const checkRef = process.env.CHECK_REF ?? sourceSha;
const statusRef = process.env.STATUS_REF ?? sourceSha;

const repositoryId = 1354872053;
const repositoryFullName = 'laurajoyhutchins/overcenter-research';

function assertCertified(
  result: CertifiedGithubSemanticReadResult,
  expectedState: 'observed' | 'page-observed',
): void {
  assert.equal(result.state, expectedState);
  if (result.state === 'indeterminate') {
    throw new Error(result.observation_error);
  }
  assert.equal(result.evidence.repository_id, repositoryId);
  assert.equal(result.evidence.requested_repository_full_name, repositoryFullName);
  assert.equal(result.evidence.schema_sha256, GITHUB_OPENAPI_SHA256);
  assert.equal(result.evidence.repository.operation_id, 'repos/get');
}

const commit = observeCertifiedGithubSemanticRead(token, {
  repositoryId,
  repositoryFullName,
  operation: 'git_commit',
  parameters: { commit_sha: sourceSha },
  grantedPermissions: ['contents:read'],
});
assertCertified(commit, 'observed');

const checks = observeCertifiedGithubSemanticRead(token, {
  repositoryId,
  repositoryFullName,
  operation: 'check_runs_for_ref',
  parameters: { ref: checkRef, page: 1, per_page: 20 },
  grantedPermissions: ['checks:read'],
});
assertCertified(checks, 'page-observed');

const statuses = observeCertifiedGithubSemanticRead(token, {
  repositoryId,
  repositoryFullName,
  operation: 'commit_statuses',
  parameters: { ref: statusRef, page: 1, per_page: 20 },
  grantedPermissions: ['statuses:read'],
});
assertCertified(statuses, 'page-observed');

const workflows = observeCertifiedGithubSemanticRead(token, {
  repositoryId,
  repositoryFullName,
  operation: 'workflow_runs',
  parameters: { page: 1, per_page: 20 },
  grantedPermissions: ['actions:read'],
});
assertCertified(workflows, 'page-observed');

for (const result of [checks, statuses, workflows]) {
  if (result.state === 'indeterminate') throw new Error(result.observation_error);
  assert.equal(result.evidence.collection?.completeness, 'page-only');
  assert.equal(result.evidence.negative_evidence_authoritative, false);
}

console.log(
  JSON.stringify(
    {
      schema_sha256: GITHUB_OPENAPI_SHA256,
      commit: {
        state: commit.state,
        operation_id:
          commit.state === 'indeterminate' ? commit.operation_id : commit.evidence.operation_id,
      },
      collections: [checks, statuses, workflows].map((result) => ({
        state: result.state,
        operation_id:
          result.state === 'indeterminate' ? result.operation_id : result.evidence.operation_id,
        negative_evidence_authoritative:
          result.state === 'indeterminate' ? null : result.evidence.negative_evidence_authoritative,
      })),
    },
    null,
    2,
  ),
);
