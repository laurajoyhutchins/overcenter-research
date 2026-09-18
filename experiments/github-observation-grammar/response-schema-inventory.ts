import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  type OpenApiDocument,
} from './openapi.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: response-schema-inventory.ts <openapi.json>');

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

const structuralKeywords = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'additionalProperties',
  'patternProperties',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'nullable',
  '$ref',
]);

interface Stats {
  nodes: number;
  max_depth: number;
  keywords: Set<string>;
  types: Set<string>;
  formats: Set<string>;
  refs: number;
  unions: number;
  required_properties: number;
}

function visit(value: unknown, depth: number, stats: Stats): void {
  if (value === null || typeof value !== 'object') return;
  stats.nodes += 1;
  stats.max_depth = Math.max(stats.max_depth, depth);

  if (Array.isArray(value)) {
    for (const child of value) visit(child, depth + 1, stats);
    return;
  }

  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (structuralKeywords.has(key)) stats.keywords.add(key);
    if (key === 'type') {
      if (typeof child === 'string') stats.types.add(child);
      if (Array.isArray(child)) {
        for (const type of child) if (typeof type === 'string') stats.types.add(type);
      }
    }
    if (key === 'format' && typeof child === 'string') stats.formats.add(child);
    if (key === '$ref') stats.refs += 1;
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(child)) {
      stats.unions += child.length;
    }
    if (key === 'required' && Array.isArray(child)) stats.required_properties += child.length;
    visit(child, depth + 1, stats);
  }
}

const results = cases.map(([pathTemplate, operationId]) => {
  const operation = deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate,
  });
  if (operation.operation_id !== operationId) {
    throw new Error(`OPERATION_ID_MISMATCH:${operationId}:${operation.operation_id}`);
  }
  const schema = operation.outcomes.find(outcome => outcome.status === '200')?.schema;
  if (!schema) throw new Error(`RESPONSE_SCHEMA_MISSING:${operationId}:200`);

  const stats: Stats = {
    nodes: 0,
    max_depth: 0,
    keywords: new Set(),
    types: new Set(),
    formats: new Set(),
    refs: 0,
    unions: 0,
    required_properties: 0,
  };
  visit(schema, 0, stats);

  return {
    operation_id: operationId,
    nodes: stats.nodes,
    max_depth: stats.max_depth,
    keywords: [...stats.keywords].sort(),
    types: [...stats.types].sort(),
    formats: [...stats.formats].sort(),
    refs: stats.refs,
    union_branches: stats.unions,
    required_properties: stats.required_properties,
  };
});

const aggregate = {
  keywords: [...new Set(results.flatMap(result => result.keywords))].sort(),
  types: [...new Set(results.flatMap(result => result.types))].sort(),
  formats: [...new Set(results.flatMap(result => result.formats))].sort(),
  refs: results.reduce((sum, result) => sum + result.refs, 0),
  union_branches: results.reduce((sum, result) => sum + result.union_branches, 0),
  max_depth: Math.max(...results.map(result => result.max_depth)),
};

console.log(JSON.stringify({ aggregate, operations: results }, null, 2));
