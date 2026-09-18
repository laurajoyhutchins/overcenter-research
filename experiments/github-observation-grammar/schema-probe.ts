import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  type OpenApiDocument,
} from './openapi.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: schema-probe.ts <openapi.json>');

const document = JSON.parse(readFileSync(schemaPath, 'utf8')) as OpenApiDocument;
const issue = deriveObservationOperation(document, {
  apiVersion: '2026-03-10',
  method: 'get',
  pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
});
const response = issue.outcomes.find(outcome => outcome.status === '200');
if (!response || response.schema === null || typeof response.schema !== 'object') {
  throw new Error('ISSUES_200_SCHEMA_UNAVAILABLE');
}

function property(schema: unknown, name: string): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`SCHEMA_NOT_OBJECT:${name}`);
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error(`SCHEMA_PROPERTIES_UNAVAILABLE:${name}`);
  }
  const child = (properties as Record<string, unknown>)[name];
  if (child === undefined) throw new Error(`SCHEMA_PROPERTY_MISSING:${name}`);
  return child;
}

const pullRequest = property(response.schema, 'pull_request');
const mergedAt = property(pullRequest, 'merged_at');

console.log(JSON.stringify({
  operation_id: issue.operation_id,
  property: '$.pull_request.merged_at',
  schema: mergedAt,
}, null, 2));
