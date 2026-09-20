import {
  validateProviderObservationEnvelope,
  type ProviderObservation,
  type ProviderObservationValidationOptions,
  type ProviderStructuralValidation,
} from './observation.ts';

export interface ResponseFieldSpec {
  path: string;
  required?: boolean;
}

export interface StructuralOperation {
  operation_id: string;
  outcomes: Array<{
    status: string;
    schema: unknown;
  }>;
}

export type StructuralObservation = ProviderObservation<string, unknown, unknown>;

export interface ResponseSliceResult {
  operation_id: string;
  status: string;
  validated_paths: string[];
  optional_absent_paths: string[];
}

export type CertifiedObservation<T extends StructuralObservation = StructuralObservation> = T & {
  structural_validation:ProviderStructuralValidation;
};

type Schema = Record<string, unknown>;
export type SchemaResolver = (ref: string) => unknown;

function object(value: unknown): Schema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Schema
    : null;
}

function resolved(schema: unknown, resolveRef?: SchemaResolver): unknown {
  let current = schema;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    const ref = object(current)?.['$ref'];
    if (typeof ref !== 'string' || !resolveRef) return current;
    if (seen.has(ref)) throw new Error(`RESPONSE_SLICE_SCHEMA_REF_CYCLE:${ref}`);
    seen.add(ref);
    current = resolveRef(ref);
  }
  throw new Error('RESPONSE_SLICE_SCHEMA_REF_DEPTH');
}

function branches(
  schema: unknown,
  keyword: 'allOf' | 'anyOf' | 'oneOf',
  resolveRef?: SchemaResolver,
): unknown[] {
  const value = object(resolved(schema, resolveRef))?.[keyword];
  return Array.isArray(value) ? value : [];
}

function propertySchemas(schema: unknown, name: string, resolveRef?: SchemaResolver): unknown[] {
  const found: unknown[] = [];
  const current = object(resolved(schema, resolveRef));
  const properties = object(current?.properties);
  if (properties && Object.hasOwn(properties, name)) found.push(properties[name]);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    for (const branch of branches(schema, keyword, resolveRef)) {
      found.push(...propertySchemas(branch, name, resolveRef));
    }
  }
  return found;
}

function itemSchemas(schema: unknown, resolveRef?: SchemaResolver): unknown[] {
  const found: unknown[] = [];
  const current = object(resolved(schema, resolveRef));
  if (current && Object.hasOwn(current, 'items')) found.push(current.items);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    for (const branch of branches(schema, keyword, resolveRef)) {
      found.push(...itemSchemas(branch, resolveRef));
    }
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

function schemaMatches(schema: unknown, value: unknown, resolveRef?: SchemaResolver): boolean {
  const current = object(resolved(schema, resolveRef));
  if (!current) return true;

  if (value === null && current.nullable === true) return true;

  const all = branches(schema, 'allOf', resolveRef);
  if (all.length > 0 && !all.every(branch => schemaMatches(branch, value, resolveRef))) return false;

  const any = branches(schema, 'anyOf', resolveRef);
  if (any.length > 0 && !any.some(branch => schemaMatches(branch, value, resolveRef))) return false;

  const one = branches(schema, 'oneOf', resolveRef);
  if (one.length > 0 && !one.some(branch => schemaMatches(branch, value, resolveRef))) return false;

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
  resolveRef?: SchemaResolver,
): 'validated' | 'optional-absent' {
  if (segments.length === 0) {
    if (!schemaCandidates.some(schema => schemaMatches(schema, value, resolveRef))) {
      throw new Error(`RESPONSE_SLICE_VALUE_MISMATCH:${fullPath}`);
    }
    return 'validated';
  }

  const [segment, ...rest] = segments;

  if (segment === '[]') {
    const items = schemaCandidates.flatMap(schema => itemSchemas(schema, resolveRef));
    assertSchemaCandidates(items, fullPath);
    if (!Array.isArray(value)) throw new Error(`RESPONSE_SLICE_ARRAY_REQUIRED:${fullPath}`);
    for (const member of value) validatePath(items, member, rest, fullPath, required, resolveRef);
    return 'validated';
  }

  const arrayProperty = segment.endsWith('[]');
  const name = arrayProperty ? segment.slice(0, -2) : segment;
  const properties = schemaCandidates.flatMap(schema => propertySchemas(schema, name, resolveRef));
  assertSchemaCandidates(properties, fullPath);

  const body = object(value);
  if (!body || !Object.hasOwn(body, name)) {
    if (!required) return 'optional-absent';
    throw new Error(`RESPONSE_SLICE_REQUIRED_FIELD_MISSING:${fullPath}`);
  }

  const child = body[name];
  if (!arrayProperty) {
    return validatePath(properties, child, rest, fullPath, required, resolveRef);
  }

  const items = properties.flatMap(schema => itemSchemas(schema, resolveRef));
  assertSchemaCandidates(items, fullPath);
  if (!Array.isArray(child)) throw new Error(`RESPONSE_SLICE_ARRAY_REQUIRED:${fullPath}`);
  for (const member of child) validatePath(items, member, rest, fullPath, required, resolveRef);
  return 'validated';
}

export function validateResponseSlice(
  operation: StructuralOperation,
  status: string,
  body: unknown,
  fields: readonly ResponseFieldSpec[],
  resolveRef?: SchemaResolver,
): ResponseSliceResult {
  const schema = operation.outcomes.find(outcome => outcome.status === status)?.schema;
  if (!schema) throw new Error(`RESPONSE_SLICE_SCHEMA_MISSING:${operation.operation_id}:${status}`);

  const validatedPaths: string[] = [];
  const optionalAbsentPaths: string[] = [];
  for (const field of fields) {
    const result = validatePath(
      [schema],
      body,
      parsePath(field.path),
      field.path,
      field.required !== false,
      resolveRef,
    );
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


interface ResponseProjectionNode {
  leaf?:boolean;
  array?:ResponseProjectionNode;
  properties?:Record<string,ResponseProjectionNode>;
}

const RESPONSE_PROJECTION_OMIT=Symbol('response-projection-omit');

function addResponseProjectionPath(root:ResponseProjectionNode,path:string):void {
  let node=root;
  for(const segment of parsePath(path)){
    if(segment==='[]'){
      node.array??={};
      node=node.array;
      continue;
    }
    const arrayProperty=segment.endsWith('[]');
    const name=arrayProperty?segment.slice(0,-2):segment;
    node.properties??={};
    node.properties[name]??={};
    node=node.properties[name];
    if(arrayProperty){
      node.array??={};
      node=node.array;
    }
  }
  node.leaf=true;
}

function projectResponseNode(
  value:unknown,
  node:ResponseProjectionNode,
):unknown|typeof RESPONSE_PROJECTION_OMIT {
  if(node.leaf===true) return value;
  if(node.array){
    if(!Array.isArray(value)) return RESPONSE_PROJECTION_OMIT;
    return value.map(member=>{
      const projected=projectResponseNode(member,node.array!);
      return projected===RESPONSE_PROJECTION_OMIT?null:projected;
    });
  }

  const body=object(value);
  if(!body) return RESPONSE_PROJECTION_OMIT;
  const projected:Record<string,unknown>={};
  for(const [name,child] of Object.entries(node.properties??{})){
    if(!Object.hasOwn(body,name)) continue;
    const childValue=projectResponseNode(body[name],child);
    if(childValue!==RESPONSE_PROJECTION_OMIT) projected[name]=childValue;
  }
  return projected;
}

/**
 * Materialize only fields named by a certified response slice.
 *
 * Validation and projection stay separate: callers validate first, then use
 * this projection as the authority-bearing value. Provider fields outside the
 * declared slice never cross the certified API boundary.
 */
export function projectResponseSlice(
  body:unknown,
  fields:readonly ResponseFieldSpec[],
):unknown {
  const root:ResponseProjectionNode={};
  for(const field of fields) addResponseProjectionPath(root,field.path);
  const projected=projectResponseNode(body,root);
  if(projected===RESPONSE_PROJECTION_OMIT){
    throw new Error('RESPONSE_SLICE_PROJECTION_ROOT_MISMATCH');
  }
  return projected;
}

export function validateObservationSlice<T extends StructuralObservation>(
  operation: StructuralOperation,
  observation: T,
  fields: readonly ResponseFieldSpec[],
  resolveRef?: SchemaResolver,
  validationOptions?: ProviderObservationValidationOptions,
): CertifiedObservation<T> {
  validateProviderObservationEnvelope(observation,validationOptions);
  if (observation.contract.operation_id !== operation.operation_id) {
    throw new Error('RESPONSE_SLICE_OPERATION_MISMATCH');
  }
  if (observation.outcome.status !== 200 || observation.outcome.visibility !== 'observed') {
    throw new Error('RESPONSE_SLICE_POSITIVE_OBSERVATION_REQUIRED');
  }

  const structural = validateResponseSlice(
    operation,
    '200',
    observation.outcome.value,
    fields,
    resolveRef,
  );

  return {
    ...observation,
    structural_validation: {
      ...structural,
      schema_sha256: observation.contract.schema_sha256,
    },
  };
}

function structuralValidationFor<T extends StructuralObservation>(
  observation:T,
  operationId:string,
):ProviderStructuralValidation|null {
  const structural=(observation as Partial<CertifiedObservation<T>>).structural_validation;
  if (!structural) return null;
  if (structural.operation_id!==operationId || structural.status!=='200') return null;
  if (structural.schema_sha256!==observation.contract.schema_sha256) return null;
  return structural;
}

export function structurallyCertifiedFor<T extends StructuralObservation>(
  observation:T,
  operationId:string,
  fields:readonly ResponseFieldSpec[],
):observation is CertifiedObservation<T> {
  const structural=structuralValidationFor(observation,operationId);
  if (!structural) return false;
  const validated=new Set(structural.validated_paths);
  const optionalAbsent=new Set(structural.optional_absent_paths);
  return fields.every(field=>{
    const present=validated.has(field.path);
    const absent=optionalAbsent.has(field.path);
    if (present===absent) return false;
    return present || field.required===false;
  });
}

export function structurallyValidatedFor<T extends StructuralObservation>(
  observation:T,
  operationId:string,
  requiredPaths:readonly string[],
):observation is CertifiedObservation<T> {
  return structurallyCertifiedFor(
    observation,
    operationId,
    requiredPaths.map(path=>({path})),
  );
}
