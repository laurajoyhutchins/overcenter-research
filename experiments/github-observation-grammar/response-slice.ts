import type { ObservationOperation, RawObservation } from './openapi.ts';

export interface ResponseFieldSpec {
  path: string;
  required?: boolean;
}

export interface ResponseSliceResult {
  operation_id: string;
  status: string;
  validated_paths: string[];
  optional_absent_paths: string[];
}

export interface StructurallyValidatedObservation extends RawObservation {
  structural_validation: ResponseSliceResult & {
    schema_sha256: string;
  };
}

type Schema = Record<string, unknown>;

function object(value: unknown): Schema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Schema
    : null;
}

function branches(schema: unknown, keyword: 'allOf' | 'anyOf' | 'oneOf'): unknown[] {
  const value = object(schema)?.[keyword];
  return Array.isArray(value) ? value : [];
}

function propertySchemas(schema: unknown, name: string): unknown[] {
  const found: unknown[] = [];
  const current = object(schema);
  const properties = object(current?.properties);
  if (properties && Object.hasOwn(properties, name)) found.push(properties[name]);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    for (const branch of branches(schema, keyword)) found.push(...propertySchemas(branch, name));
  }
  return found;
}

function itemSchemas(schema: unknown): unknown[] {
  const found: unknown[] = [];
  const current = object(schema);
  if (current && Object.hasOwn(current, 'items')) found.push(current.items);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    for (const branch of branches(schema, keyword)) found.push(...itemSchemas(branch));
  }
  return found;
}

function primitiveTypeMatches(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return true;
}

function schemaMatches(schema: unknown, value: unknown): boolean {
  const current = object(schema);
  if (!current) return true;

  if (value === null && current.nullable === true) return true;

  const all = branches(schema, 'allOf');
  if (all.length > 0 && !all.every(branch => schemaMatches(branch, value))) return false;

  const any = branches(schema, 'anyOf');
  if (any.length > 0 && !any.some(branch => schemaMatches(branch, value))) return false;

  const one = branches(schema, 'oneOf');
  if (one.length > 0 && !one.some(branch => schemaMatches(branch, value))) return false;

  const type = current.type;
  if (typeof type === 'string' && !primitiveTypeMatches(type, value)) return false;
  if (Array.isArray(type)) {
    const types = type.filter(candidate => typeof candidate === 'string') as string[];
    if (types.length > 0 && !types.some(candidate => primitiveTypeMatches(candidate, value))) return false;
  }

  if (Array.isArray(current.enum) && !current.enum.some(candidate => Object.is(candidate, value))) return false;

  if (typeof value === 'string') {
    if (typeof current.minLength === 'number' && value.length < current.minLength) return false;
    if (typeof current.maxLength === 'number' && value.length > current.maxLength) return false;
  }

  return true;
}

function parsePath(path: string): string[] {
  if (!path) throw new Error('RESPONSE_SLICE_PATH_EMPTY');
  return path.split('.').filter(Boolean);
}

function assertSchemaCandidates(candidates: unknown[], path: string): void {
  if (candidates.length === 0) throw new Error(`RESPONSE_SLICE_SCHEMA_PATH_NOT_FOUND:${path}`);
}

function validatePath(
  schemaCandidates: unknown[],
  value: unknown,
  segments: string[],
  fullPath: string,
  required: boolean,
): 'validated' | 'optional-absent' {
  if (segments.length === 0) {
    if (!schemaCandidates.some(schema => schemaMatches(schema, value))) {
      throw new Error(`RESPONSE_SLICE_VALUE_MISMATCH:${fullPath}`);
    }
    return 'validated';
  }

  const [segment, ...rest] = segments;

  if (segment === '[]') {
    const items = schemaCandidates.flatMap(itemSchemas);
    assertSchemaCandidates(items, fullPath);
    if (!Array.isArray(value)) throw new Error(`RESPONSE_SLICE_ARRAY_REQUIRED:${fullPath}`);
    for (const member of value) validatePath(items, member, rest, fullPath, true);
    return 'validated';
  }

  const arrayProperty = segment.endsWith('[]');
  const name = arrayProperty ? segment.slice(0, -2) : segment;
  const properties = schemaCandidates.flatMap(schema => propertySchemas(schema, name));
  assertSchemaCandidates(properties, fullPath);

  const body = object(value);
  if (!body || !Object.hasOwn(body, name)) {
    if (!required) return 'optional-absent';
    throw new Error(`RESPONSE_SLICE_REQUIRED_FIELD_MISSING:${fullPath}`);
  }

  const child = body[name];
  if (!arrayProperty) return validatePath(properties, child, rest, fullPath, required);

  const items = properties.flatMap(itemSchemas);
  assertSchemaCandidates(items, fullPath);
  if (!Array.isArray(child)) throw new Error(`RESPONSE_SLICE_ARRAY_REQUIRED:${fullPath}`);
  for (const member of child) validatePath(items, member, rest, fullPath, true);
  return 'validated';
}

export function validateResponseSlice(
  operation: ObservationOperation,
  status: string,
  body: unknown,
  fields: readonly ResponseFieldSpec[],
): ResponseSliceResult {
  const schema = operation.outcomes.find(outcome => outcome.status === status)?.schema;
  if (!schema) throw new Error(`RESPONSE_SLICE_SCHEMA_MISSING:${operation.operation_id}:${status}`);

  const validatedPaths: string[] = [];
  const optionalAbsentPaths: string[] = [];
  for (const field of fields) {
    const result = validatePath([schema], body, parsePath(field.path), field.path, field.required !== false);
    if (result === 'validated') validatedPaths.push(field.path);
    else optionalAbsentPaths.push(field.path);
  }

  return {
    operation_id: operation.operation_id,
    status,
    validated_paths: validatedPaths,
    optional_absent_paths: optionalAbsentPaths,
  };
}

export function validateObservationSlice(
  operation: ObservationOperation,
  observation: RawObservation,
  fields: readonly ResponseFieldSpec[],
): StructurallyValidatedObservation {
  if (observation.contract.operation_id !== operation.operation_id) {
    throw new Error('RESPONSE_SLICE_OPERATION_MISMATCH');
  }
  if (observation.outcome.status !== 200 || observation.outcome.visibility !== 'observed') {
    throw new Error('RESPONSE_SLICE_POSITIVE_OBSERVATION_REQUIRED');
  }
  const structural = validateResponseSlice(operation, '200', observation.outcome.value, fields);
  return {
    ...observation,
    structural_validation: {
      ...structural,
      schema_sha256: observation.contract.schema_sha256,
    },
  };
}

export function structurallyValidatedFor(
  observation: RawObservation,
  operationId: string,
  requiredPaths: readonly string[],
): observation is StructurallyValidatedObservation {
  const structural = (observation as Partial<StructurallyValidatedObservation>).structural_validation;
  if (!structural) return false;
  if (structural.operation_id !== operationId || structural.status !== '200') return false;
  if (structural.schema_sha256 !== observation.contract.schema_sha256) return false;
  const validated = new Set(structural.validated_paths);
  return requiredPaths.every(path => validated.has(path));
}

export const RESPONSE_SLICES = {
  'repos/get': [
    { path: 'id' },
    { path: 'node_id' },
    { path: 'full_name' },
    { path: 'name' },
    { path: 'owner.login' },
  ],
  'git/get-ref': [
    { path: 'ref' },
    { path: 'object.type' },
    { path: 'object.sha' },
  ],
  'git/get-commit': [
    { path: 'sha' },
    { path: 'tree.sha' },
    { path: 'parents[].sha' },
  ],
  'pulls/get': [
    { path: 'id' },
    { path: 'node_id' },
    { path: 'number' },
    { path: 'state' },
    { path: 'head.sha' },
    { path: 'base.ref' },
    { path: 'base.sha' },
  ],
  'issues/get': [
    { path: 'id' },
    { path: 'node_id' },
    { path: 'number' },
    { path: 'state' },
    { path: 'title' },
    { path: 'locked' },
    { path: 'pull_request', required: false },
  ],
  'checks/list-for-ref': [
    { path: 'total_count' },
    { path: 'check_runs[].id' },
    { path: 'check_runs[].name' },
    { path: 'check_runs[].head_sha' },
    { path: 'check_runs[].status' },
    { path: 'check_runs[].conclusion' },
  ],
  'repos/list-commit-statuses-for-ref': [
    { path: '[].id' },
    { path: '[].node_id' },
    { path: '[].state' },
    { path: '[].context' },
    { path: '[].target_url' },
    { path: '[].created_at' },
    { path: '[].updated_at' },
  ],
  'actions/list-workflow-runs-for-repo': [
    { path: 'total_count' },
    { path: 'workflow_runs[].id' },
    { path: 'workflow_runs[].node_id' },
    { path: 'workflow_runs[].workflow_id' },
    { path: 'workflow_runs[].run_number' },
    { path: 'workflow_runs[].run_attempt' },
    { path: 'workflow_runs[].name' },
    { path: 'workflow_runs[].event' },
    { path: 'workflow_runs[].status' },
    { path: 'workflow_runs[].conclusion' },
    { path: 'workflow_runs[].head_sha' },
  ],
} as const satisfies Record<string, readonly ResponseFieldSpec[]>;
