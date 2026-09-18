import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  GitHubRestTransport,
  observeOperation,
  type ObservationOperation,
  type ObservationProvenance,
  type OpenApiDocument,
  type RawObservation,
} from './openapi.ts';
import { validateObservationStructure } from './structural-decoder.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: live-structural-proof.ts <openapi.json>');

const repositoryName = required('GITHUB_REPOSITORY');
const sourceRef = required('SOURCE_REF');
const sourceSha = required('SOURCE_SHA');
const checkRef = required('CHECK_REF');
const statusRef = required('STATUS_REF');
const pullNumber = process.env.PULL_NUMBER ? Number(process.env.PULL_NUMBER) : null;
if (pullNumber !== null && (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)) {
  throw new Error('PULL_NUMBER_INVALID');
}
const [owner, repo] = repositoryName.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY_INVALID');

const schemaBytes = readFileSync(schemaPath);
const document = JSON.parse(schemaBytes.toString('utf8')) as OpenApiDocument;
const provenance: ObservationProvenance = {
  schema_sha256: createHash('sha256').update(schemaBytes).digest('hex'),
  observer: {
    kind: 'github-actions-run',
    id: `${repositoryName}:${required('GITHUB_RUN_ID')}:${required('GITHUB_RUN_ATTEMPT')}`,
  },
};
const transport = new GitHubRestTransport({ token: process.env.GITHUB_TOKEN ?? null });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function op(pathTemplate: string): ObservationOperation {
  return deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate,
  });
}

async function observed(
  operation: ObservationOperation,
  values: Record<string, string | number | boolean>,
): Promise<RawObservation> {
  const observation = await observeOperation(operation, values, transport, provenance);
  assert.equal(
    observation.outcome.status,
    200,
    `${operation.operation_id} live observation must return 200 before structural validation`,
  );
  return observation;
}

function assertValid(
  operation: ObservationOperation,
  observation: RawObservation,
): { operation_id: string; state: 'VALID'; response_status: number } {
  const result = validateObservationStructure(operation, observation);
  assert.equal(
    result.state,
    'VALID',
    `${operation.operation_id} structural result: ${JSON.stringify(result)}`,
  );
  return {
    operation_id: operation.operation_id,
    state: 'VALID',
    response_status: observation.outcome.status,
  };
}

const results: Array<{ operation_id: string; state: 'VALID'; response_status: number }> = [];

const repoOperation = op('/repos/{owner}/{repo}');
results.push(assertValid(
  repoOperation,
  await observed(repoOperation, { owner, repo }),
));

const refOperation = op('/repos/{owner}/{repo}/git/ref/{ref}');
results.push(assertValid(
  refOperation,
  await observed(refOperation, { owner, repo, ref: `heads/${sourceRef}` }),
));

const commitOperation = op('/repos/{owner}/{repo}/git/commits/{commit_sha}');
results.push(assertValid(
  commitOperation,
  await observed(commitOperation, { owner, repo, commit_sha: sourceSha }),
));

const checkOperation = op('/repos/{owner}/{repo}/commits/{ref}/check-runs');
results.push(assertValid(
  checkOperation,
  await observed(checkOperation, { owner, repo, ref: checkRef, page: 1, per_page: 1 }),
));

const statusOperation = op('/repos/{owner}/{repo}/commits/{ref}/statuses');
results.push(assertValid(
  statusOperation,
  await observed(statusOperation, { owner, repo, ref: statusRef, page: 1, per_page: 1 }),
));

const runsOperation = op('/repos/{owner}/{repo}/actions/runs');
results.push(assertValid(
  runsOperation,
  await observed(runsOperation, { owner, repo, page: 1, per_page: 1 }),
));

if (pullNumber !== null) {
  const pullOperation = op('/repos/{owner}/{repo}/pulls/{pull_number}');
  results.push(assertValid(
    pullOperation,
    await observed(pullOperation, { owner, repo, pull_number: pullNumber }),
  ));

  const issueOperation = op('/repos/{owner}/{repo}/issues/{issue_number}');
  results.push(assertValid(
    issueOperation,
    await observed(issueOperation, { owner, repo, issue_number: pullNumber }),
  ));
}

console.log(JSON.stringify({
  schema_sha256: provenance.schema_sha256,
  observer: provenance.observer,
  structural_validation: results,
}, null, 2));
