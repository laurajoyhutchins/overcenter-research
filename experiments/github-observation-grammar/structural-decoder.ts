import type { ObservationOperation, RawObservation } from './openapi.ts';

export type StructuralState = 'VALID' | 'INVALID' | 'UNSUPPORTED';

export interface StructuralProblem {
  path: string;
  reason: string;
}

export interface StructuralResult {
  state: StructuralState;
  problems: StructuralProblem[];
}

type Schema = boolean | Record<string, unknown>;

const STRUCTURAL_KEYWORDS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'type',
  'nullable',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'patternProperties',
  'dependentSchemas',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'contains',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);

function valid(): StructuralResult {
  return { state: 'VALID', problems: [] };
}

function problem(state: Exclude<StructuralState, 'VALID'>, path: string, reason: string): StructuralResult {
  return { state, problems: [{ path, reason }] };
}

function mergeAll(results: StructuralResult[]): StructuralResult {
  const invalid = results.filter(result => result.state === 'INVALID');
  if (invalid.length > 0) return {
    state: 'INVALID',
    problems: invalid.flatMap(result => result.problems),
  };
  const unsupported = results.filter(result => result.state === 'UNSUPPORTED');
  if (unsupported.length > 0) return {
    state: 'UNSUPPORTED',
    problems: unsupported.flatMap(result => result.problems),
  };
  return valid();
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function schemaArray(value: unknown): Schema[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'boolean' || (item !== null && typeof item === 'object'))
    ? value as Schema[]
    : null;
}

function schemaObject(value: unknown): Record<string, Schema> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'boolean' || (item !== null && typeof item === 'object'))) return null;
  return Object.fromEntries(entries) as Record<string, Schema>;
}

function validateCombinators(schema: Record<string, unknown>, value: unknown, path: string): StructuralResult {
  if ('$ref' in schema) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_REF_UNRESOLVED');

  if ('allOf' in schema) {
    const branches = schemaArray(schema.allOf);
    if (!branches) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ALLOF_INVALID');
    const result = mergeAll(branches.map(branch => validateStructure(branch, value, path)));
    if (result.state !== 'VALID') return result;
  }

  if ('anyOf' in schema) {
    const branches = schemaArray(schema.anyOf);
    if (!branches) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ANYOF_INVALID');
    const results = branches.map(branch => validateStructure(branch, value, path));
    if (!results.some(result => result.state === 'VALID')) {
      if (results.some(result => result.state === 'UNSUPPORTED')) {
        return {
          state: 'UNSUPPORTED',
          problems: results.flatMap(result => result.problems),
        };
      }
      return problem('INVALID', path, 'STRUCTURAL_ANYOF_NO_MATCH');
    }
  }

  if ('oneOf' in schema) {
    const branches = schemaArray(schema.oneOf);
    if (!branches) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ONEOF_INVALID');
    const results = branches.map(branch => validateStructure(branch, value, path));
    const matches = results.filter(result => result.state === 'VALID').length;
    if (matches !== 1) {
      if (matches === 0 && results.some(result => result.state === 'UNSUPPORTED')) {
        return {
          state: 'UNSUPPORTED',
          problems: results.flatMap(result => result.problems),
        };
      }
      return problem('INVALID', path, `STRUCTURAL_ONEOF_MATCH_COUNT:${matches}`);
    }
  }

  if ('not' in schema) {
    const branch = schema.not;
    if (!(typeof branch === 'boolean' || (branch !== null && typeof branch === 'object' && !Array.isArray(branch)))) {
      return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_NOT_INVALID');
    }
    const result = validateStructure(branch as Schema, value, path);
    if (result.state === 'UNSUPPORTED') return result;
    if (result.state === 'VALID') return problem('INVALID', path, 'STRUCTURAL_NOT_MATCHED');
  }

  if ('if' in schema) {
    const branch = schema.if;
    if (!(typeof branch === 'boolean' || (branch !== null && typeof branch === 'object' && !Array.isArray(branch)))) {
      return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_IF_INVALID');
    }
    const condition = validateStructure(branch as Schema, value, path);
    if (condition.state === 'UNSUPPORTED') return condition;
    const selected = condition.state === 'VALID' ? schema.then : schema.else;
    if (selected !== undefined) {
      if (!(typeof selected === 'boolean' || (selected !== null && typeof selected === 'object' && !Array.isArray(selected)))) {
        return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_CONDITIONAL_INVALID');
      }
      const result = validateStructure(selected as Schema, value, path);
      if (result.state !== 'VALID') return result;
    }
  }

  return valid();
}

function validateObject(schema: Record<string, unknown>, value: Record<string, unknown>, path: string): StructuralResult {
  if ('patternProperties' in schema || 'dependentSchemas' in schema || 'unevaluatedProperties' in schema) {
    return problem('UNSUPPORTED', path, 'STRUCTURAL_OBJECT_KEYWORD_UNSUPPORTED');
  }

  const minProperties = schema.minProperties;
  if (typeof minProperties === 'number' && Object.keys(value).length < minProperties) {
    return problem('INVALID', path, 'STRUCTURAL_MIN_PROPERTIES');
  }
  const maxProperties = schema.maxProperties;
  if (typeof maxProperties === 'number' && Object.keys(value).length > maxProperties) {
    return problem('INVALID', path, 'STRUCTURAL_MAX_PROPERTIES');
  }

  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every(item => typeof item === 'string')) {
      return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_REQUIRED_INVALID');
    }
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        return problem('INVALID', `${path}.${name}`, 'STRUCTURAL_REQUIRED_PROPERTY_MISSING');
      }
    }
  }

  const properties = schema.properties === undefined ? {} : schemaObject(schema.properties);
  if (properties === null) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_PROPERTIES_INVALID');

  const results: StructuralResult[] = [];
  for (const [name, childSchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    results.push(validateStructure(childSchema, value[name], `${path}.${name}`));
  }

  const known = new Set(Object.keys(properties));
  const extras = Object.keys(value).filter(name => !known.has(name));
  if (schema.additionalProperties === false && extras.length > 0) {
    return problem('INVALID', `${path}.${extras[0]}`, 'STRUCTURAL_ADDITIONAL_PROPERTY_FORBIDDEN');
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true && schema.additionalProperties !== false) {
    const additional = schema.additionalProperties;
    if (!(additional !== null && typeof additional === 'object' && !Array.isArray(additional))) {
      return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ADDITIONAL_PROPERTIES_INVALID');
    }
    for (const name of extras) {
      results.push(validateStructure(additional as Schema, value[name], `${path}.${name}`));
    }
  }

  return mergeAll(results);
}

function validateArray(schema: Record<string, unknown>, value: unknown[], path: string): StructuralResult {
  if ('contains' in schema) return problem('UNSUPPORTED', path, 'STRUCTURAL_ARRAY_CONTAINS_UNSUPPORTED');

  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    return problem('INVALID', path, 'STRUCTURAL_MIN_ITEMS');
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    return problem('INVALID', path, 'STRUCTURAL_MAX_ITEMS');
  }

  const results: StructuralResult[] = [];
  if (schema.prefixItems !== undefined) {
    const prefix = schemaArray(schema.prefixItems);
    if (!prefix) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_PREFIX_ITEMS_INVALID');
    for (let index = 0; index < Math.min(prefix.length, value.length); index += 1) {
      results.push(validateStructure(prefix[index], value[index], `${path}[${index}]`));
    }
  }

  if (schema.items !== undefined) {
    if (schema.items === false) {
      const prefixCount = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      if (value.length > prefixCount) return problem('INVALID', path, 'STRUCTURAL_ADDITIONAL_ITEMS_FORBIDDEN');
    } else if (schema.items !== true) {
      if (!(schema.items !== null && typeof schema.items === 'object' && !Array.isArray(schema.items))) {
        return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ITEMS_INVALID');
      }
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index += 1) {
        results.push(validateStructure(schema.items as Schema, value[index], `${path}[${index}]`));
      }
    }
  }

  return mergeAll(results);
}

export function validateStructure(schema: Schema, value: unknown, path = '$'): StructuralResult {
  if (schema === true) return valid();
  if (schema === false) return problem('INVALID', path, 'STRUCTURAL_FALSE_SCHEMA');
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_INVALID');
  }

  const combinator = validateCombinators(schema, value, path);
  if (combinator.state !== 'VALID') return combinator;

  if (schema.nullable === true && value === null) return valid();

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_ENUM_INVALID');
    if (!schema.enum.some(candidate => jsonEqual(candidate, value))) {
      return problem('INVALID', path, 'STRUCTURAL_ENUM_MISMATCH');
    }
  }
  if ('const' in schema && !jsonEqual(schema.const, value)) {
    return problem('INVALID', path, 'STRUCTURAL_CONST_MISMATCH');
  }

  const type = schema.type;
  if (type !== undefined) {
    const types = typeof type === 'string'
      ? [type]
      : Array.isArray(type) && type.every(item => typeof item === 'string')
        ? type as string[]
        : null;
    if (!types) return problem('UNSUPPORTED', path, 'STRUCTURAL_SCHEMA_TYPE_INVALID');
    if (!types.some(candidate => matchesType(value, candidate))) {
      return problem('INVALID', path, `STRUCTURAL_TYPE_MISMATCH:${types.join('|')}`);
    }
  }

  const objectKeywords = ['required', 'properties', 'additionalProperties', 'patternProperties', 'dependentSchemas', 'unevaluatedProperties', 'minProperties', 'maxProperties'];
  if (objectKeywords.some(keyword => keyword in schema)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return problem('INVALID', path, 'STRUCTURAL_OBJECT_REQUIRED');
    }
    const result = validateObject(schema, value as Record<string, unknown>, path);
    if (result.state !== 'VALID') return result;
  }

  const arrayKeywords = ['items', 'prefixItems', 'contains', 'minItems', 'maxItems'];
  if (arrayKeywords.some(keyword => keyword in schema)) {
    if (!Array.isArray(value)) return problem('INVALID', path, 'STRUCTURAL_ARRAY_REQUIRED');
    const result = validateArray(schema, value, path);
    if (result.state !== 'VALID') return result;
  }

  // Non-structural validation keywords (format, pattern, bounds, descriptions, examples)
  // are intentionally left to semantic or domain validation.
  void STRUCTURAL_KEYWORDS;
  return valid();
}

export function validateObservationStructure(
  operation: ObservationOperation,
  observation: RawObservation,
): StructuralResult {
  if (observation.contract.provider !== operation.provider
    || observation.contract.api_version !== operation.api_version
    || observation.contract.operation_id !== operation.operation_id) {
    return problem('INVALID', '$', 'STRUCTURAL_OPERATION_IDENTITY_MISMATCH');
  }

  const outcome = operation.outcomes.find(candidate => candidate.status === String(observation.outcome.status));
  if (!outcome) return problem('UNSUPPORTED', '$', 'STRUCTURAL_OUTCOME_NOT_IN_CONTRACT');
  if (outcome.schema === null || outcome.schema === undefined) {
    return problem('UNSUPPORTED', '$', 'STRUCTURAL_RESPONSE_SCHEMA_UNAVAILABLE');
  }
  if (observation.outcome.value === undefined) {
    return problem('INVALID', '$', 'STRUCTURAL_RESPONSE_BODY_MISSING');
  }
  return validateStructure(outcome.schema as Schema, observation.outcome.value);
}


export type StructuralSelection =
  | true
  | {
      properties?: Record<string, StructuralSelection>;
      items?: StructuralSelection;
    };

interface ProjectedSchema {
  state: 'VALID' | 'UNSUPPORTED';
  schema?: Schema;
  problems: StructuralProblem[];
}

function projected(schema: Schema): ProjectedSchema {
  return { state: 'VALID', schema, problems: [] };
}

function unsupported(path: string, reason: string): ProjectedSchema {
  return { state: 'UNSUPPORTED', problems: [{ path, reason }] };
}

function projectSelectedSchema(
  schema: Schema,
  selection: StructuralSelection,
  path = '$',
): ProjectedSchema {
  if (schema === false) return projected(false);
  if (schema === true) return unsupported(path, 'SELECTED_SCHEMA_UNCONSTRAINED');
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return unsupported(path, 'SELECTED_SCHEMA_INVALID');
  }
  if ('$ref' in schema) return unsupported(path, 'SELECTED_SCHEMA_REF_UNRESOLVED');

  const output: Record<string, unknown> = {};
  for (const key of ['type', 'nullable', 'enum', 'const']) {
    if (key in schema) output[key] = schema[key];
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!(key in schema)) continue;
    const branches = schemaArray(schema[key]);
    if (!branches) return unsupported(path, `SELECTED_SCHEMA_${key.toUpperCase()}_INVALID`);
    const projectedBranches: Schema[] = [];
    for (const branch of branches) {
      const result = projectSelectedSchema(branch, selection, path);
      if (result.state !== 'VALID' || result.schema === undefined) return result;
      projectedBranches.push(result.schema);
    }
    output[key] = projectedBranches;
  }

  if ('not' in schema) {
    const branch = schema.not;
    if (!(typeof branch === 'boolean' || (branch !== null && typeof branch === 'object' && !Array.isArray(branch)))) {
      return unsupported(path, 'SELECTED_SCHEMA_NOT_INVALID');
    }
    const result = projectSelectedSchema(branch as Schema, selection, path);
    if (result.state !== 'VALID' || result.schema === undefined) return result;
    output.not = result.schema;
  }

  if (selection === true) {
    if (Object.keys(output).length === 0) {
      return unsupported(path, 'SELECTED_SCHEMA_HAS_NO_STRUCTURAL_CONSTRAINT');
    }
    return projected(output);
  }

  if (selection.properties) {
    const sourceProperties = schemaObject(schema.properties);
    if (!sourceProperties) return unsupported(path, 'SELECTED_SCHEMA_PROPERTIES_UNAVAILABLE');
    const selectedProperties: Record<string, Schema> = {};
    for (const [name, childSelection] of Object.entries(selection.properties)) {
      const childSchema = sourceProperties[name];
      if (childSchema === undefined) {
        return unsupported(`${path}.${name}`, 'SELECTED_SCHEMA_PROPERTY_UNAVAILABLE');
      }
      const result = projectSelectedSchema(childSchema, childSelection, `${path}.${name}`);
      if (result.state !== 'VALID' || result.schema === undefined) return result;
      selectedProperties[name] = result.schema;
    }
    output.type ??= 'object';
    output.properties = selectedProperties;
    // Selection is semantic: every selected field is required for this proposition,
    // even if the provider's general response schema marks it optional.
    output.required = Object.keys(selectedProperties);
  }

  if (selection.items) {
    const sourceItems = schema.items;
    if (!(typeof sourceItems === 'boolean' || (sourceItems !== null && typeof sourceItems === 'object' && !Array.isArray(sourceItems)))) {
      return unsupported(path, 'SELECTED_SCHEMA_ITEMS_UNAVAILABLE');
    }
    const result = projectSelectedSchema(sourceItems as Schema, selection.items, `${path}[]`);
    if (result.state !== 'VALID' || result.schema === undefined) return result;
    output.type ??= 'array';
    output.items = result.schema;
  }

  if (Object.keys(output).length === 0) {
    return unsupported(path, 'SELECTED_SCHEMA_HAS_NO_STRUCTURAL_CONSTRAINT');
  }
  return projected(output);
}

export function validateSelectedStructure(
  schema: Schema,
  value: unknown,
  selection: StructuralSelection,
): StructuralResult {
  const projection = projectSelectedSchema(schema, selection);
  if (projection.state !== 'VALID' || projection.schema === undefined) {
    return { state: 'UNSUPPORTED', problems: projection.problems };
  }
  return validateStructure(projection.schema, value);
}

export function validateSelectedObservationStructure(
  operation: ObservationOperation,
  observation: RawObservation,
  selection: StructuralSelection,
): StructuralResult {
  if (observation.contract.provider !== operation.provider
    || observation.contract.api_version !== operation.api_version
    || observation.contract.operation_id !== operation.operation_id) {
    return problem('INVALID', '$', 'STRUCTURAL_OPERATION_IDENTITY_MISMATCH');
  }
  const outcome = operation.outcomes.find(candidate => candidate.status === String(observation.outcome.status));
  if (!outcome) return problem('UNSUPPORTED', '$', 'STRUCTURAL_OUTCOME_NOT_IN_CONTRACT');
  if (outcome.schema === null || outcome.schema === undefined) {
    return problem('UNSUPPORTED', '$', 'STRUCTURAL_RESPONSE_SCHEMA_UNAVAILABLE');
  }
  if (observation.outcome.value === undefined) {
    return problem('INVALID', '$', 'STRUCTURAL_RESPONSE_BODY_MISSING');
  }
  return validateSelectedStructure(outcome.schema as Schema, observation.outcome.value, selection);
}
