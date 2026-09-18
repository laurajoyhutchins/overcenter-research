import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveObservationCatalog, type OpenApiDocument } from './openapi.ts';

const [schemaPath, apiVersion = '2026-03-10'] = process.argv.slice(2);
if (!schemaPath) throw new Error('usage: github-openapi-inventory.ts <openapi.json> [api-version]');

const document = JSON.parse(readFileSync(schemaPath, 'utf8')) as OpenApiDocument;
const catalog = deriveObservationCatalog(document, apiVersion);
const ids = catalog.map(operation => operation.operation_id);
const uniqueIds = new Set(ids);
const methods = catalog.reduce<Record<string, number>>((counts, operation) => {
  counts[operation.method] = (counts[operation.method] ?? 0) + 1;
  return counts;
}, {});
const totalParameters = catalog.reduce((sum, operation) => sum + operation.parameters.length, 0);
const totalOutcomes = catalog.reduce((sum, operation) => sum + operation.outcomes.length, 0);
const appEnabled = catalog.filter(operation => operation.github_extensions.enabledForGitHubApps === true).length;
const gitRef = catalog.find(operation => operation.operation_id === 'git/get-ref');

assert.ok(catalog.length > 500, `unexpectedly small read catalog: ${catalog.length}`);
assert.equal(uniqueIds.size, ids.length, 'OpenAPI read operation IDs must be unique');
assert.ok(catalog.every(operation => operation.method === 'GET' || operation.method === 'HEAD'));
assert.ok(gitRef, 'git/get-ref must be present in the generated catalog');
assert.equal(gitRef.method, 'GET');
assert.ok(gitRef.outcomes.some(outcome => outcome.status === '200'));
assert.ok(gitRef.outcomes.some(outcome => outcome.status === '404'));

console.log(JSON.stringify({
  source: schemaPath,
  api_version: apiVersion,
  read_operations: catalog.length,
  methods,
  unique_operation_ids: uniqueIds.size,
  parameters: totalParameters,
  documented_outcomes: totalOutcomes,
  github_app_enabled: appEnabled,
  git_get_ref: {
    path_template: gitRef.path_template,
    parameters: gitRef.parameters.map(parameter => `${parameter.in}:${parameter.name}`),
    outcomes: gitRef.outcomes.map(outcome => outcome.status),
  },
}, null, 2));
