import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveObservationOperation, type OpenApiDocument } from './openapi.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: semantic-inventory.ts <openapi.json>');
const document = JSON.parse(readFileSync(schemaPath, 'utf8')) as OpenApiDocument;
const cases = [
  ['/repos/{owner}/{repo}', 'repos/get'],
  ['/repos/{owner}/{repo}/git/ref/{ref}', 'git/get-ref'],
  ['/repos/{owner}/{repo}/git/commits/{commit_sha}', 'git/get-commit'],
  ['/repos/{owner}/{repo}/pulls/{pull_number}', 'pulls/get'],
  ['/repos/{owner}/{repo}/issues/{issue_number}', 'issues/get'],
  ['/repos/{owner}/{repo}/commits/{ref}/check-runs', 'checks/list-for-ref'],
  ['/repos/{owner}/{repo}/commits/{ref}/statuses', 'repos/list-commit-statuses-for-ref'],
  ['/repos/{owner}/{repo}/actions/runs', 'actions/list-workflow-runs-for-repo'],
] as const;

const result = cases.map(([pathTemplate, expectedOperationId]) => {
  const operation = deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate,
  });
  assert.equal(operation.operation_id, expectedOperationId);
  return {
    semantic_shape: expectedOperationId === 'repos/get' ? 'stable identity'
      : expectedOperationId === 'git/get-commit' ? 'immutable singleton'
        : expectedOperationId === 'git/get-ref' ? 'mutable binding'
          : ['pulls/get', 'issues/get'].includes(expectedOperationId) ? 'mutable entity'
            : 'paginated collection',
    operation_id: operation.operation_id,
    path_template: operation.path_template,
    parameters: operation.parameters.map(parameter => `${parameter.in}:${parameter.name}`),
    outcomes: operation.outcomes.map(outcome => outcome.status),
  };
});

console.log(JSON.stringify(result, null, 2));
