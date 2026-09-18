import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  type ObservationOperation,
  type OpenApiDocument,
} from './openapi.ts';
import { RESPONSE_SLICES } from './response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_COMMIT_STATUSES_OPERATION,
  GITHUB_OPENAPI_SHA256,
} from '../../src/providers/github-certified-status.ts';

const schemaPath=process.argv[2];
if (!schemaPath) throw new Error('usage: verify-kernel-status-contract.ts <openapi.json>');

const bytes=readFileSync(schemaPath);
const actualDigest=createHash('sha256').update(bytes).digest('hex');
assert.equal(actualDigest,GITHUB_OPENAPI_SHA256,'PINNED_OPENAPI_DIGEST_MISMATCH');

const document=JSON.parse(bytes.toString('utf8')) as OpenApiDocument;
const pinned=deriveObservationOperation(document,{
  apiVersion:GITHUB_API_VERSION,
  method:'get',
  pathTemplate:'/repos/{owner}/{repo}/commits/{ref}/statuses',
});

assert.equal(pinned.operation_id,GITHUB_COMMIT_STATUSES_OPERATION.operation_id);
assert.equal(pinned.path_template,GITHUB_COMMIT_STATUSES_OPERATION.path_template);
assert.equal(pinned.method,GITHUB_COMMIT_STATUSES_OPERATION.method);
assert.deepEqual(
  pinned.parameters.map(parameter=>[parameter.in,parameter.name,parameter.required]),
  GITHUB_COMMIT_STATUSES_OPERATION.parameters.map(parameter=>[parameter.in,parameter.name,parameter.required]),
);

type Schema=Record<string,unknown>;

function object(value:unknown):Schema|null {
  return value!==null && typeof value==='object' && !Array.isArray(value)
    ? value as Schema
    : null;
}

function branches(schema:unknown,keyword:'allOf'|'anyOf'|'oneOf'):unknown[] {
  const value=object(schema)?.[keyword];
  return Array.isArray(value)?value:[];
}

function propertySchemas(schema:unknown,name:string):unknown[] {
  const found:unknown[]=[];
  const current=object(schema);
  const properties=object(current?.properties);
  if (properties && Object.hasOwn(properties,name)) found.push(properties[name]);
  for (const keyword of ['allOf','anyOf','oneOf'] as const) {
    for (const branch of branches(schema,keyword)) found.push(...propertySchemas(branch,name));
  }
  return found;
}

function itemSchemas(schema:unknown):unknown[] {
  const found:unknown[]=[];
  const current=object(schema);
  if (current && Object.hasOwn(current,'items')) found.push(current.items);
  for (const keyword of ['allOf','anyOf','oneOf'] as const) {
    for (const branch of branches(schema,keyword)) found.push(...itemSchemas(branch));
  }
  return found;
}

function pathSchemas(root:unknown,path:string):unknown[] {
  let candidates:unknown[]=[root];
  for (const segment of path.split('.').filter(Boolean)) {
    if (segment==='[]') {
      candidates=candidates.flatMap(itemSchemas);
      continue;
    }
    const arrayProperty=segment.endsWith('[]');
    const name=arrayProperty?segment.slice(0,-2):segment;
    candidates=candidates.flatMap(schema=>propertySchemas(schema,name));
    if (arrayProperty) candidates=candidates.flatMap(itemSchemas);
  }
  return candidates;
}

function structuralSummary(schema:unknown):unknown {
  const current=object(schema);
  if (!current) return current;
  const result:Schema={};
  for (const key of ['type','nullable','enum','minLength','maxLength'] as const) {
    if (Object.hasOwn(current,key)) result[key]=current[key];
  }
  for (const keyword of ['allOf','anyOf','oneOf'] as const) {
    const values=branches(schema,keyword);
    if (values.length>0) result[keyword]=values.map(structuralSummary);
  }
  return result;
}

function summaries(operation:ObservationOperation,path:string):string[] {
  const schema=operation.outcomes.find(outcome=>outcome.status==='200')?.schema;
  if (!schema) throw new Error(`STATUS_SCHEMA_MISSING:${operation.operation_id}`);
  const candidates=pathSchemas(schema,path);
  if (candidates.length===0) throw new Error(`STATUS_SCHEMA_PATH_MISSING:${path}`);
  return candidates
    .map(candidate=>JSON.stringify(structuralSummary(candidate)))
    .sort();
}

const fields=RESPONSE_SLICES['repos/list-commit-statuses-for-ref'];
const verified:Record<string,string[]>={};
for (const field of fields) {
  const expected=summaries(pinned,field.path);
  const generated=summaries(GITHUB_COMMIT_STATUSES_OPERATION,field.path);
  assert.deepEqual(generated,expected,`GENERATED_STATUS_SCHEMA_DRIFT:${field.path}`);
  verified[field.path]=generated;
}

console.log(JSON.stringify({
  schema_sha256:actualDigest,
  operation_id:pinned.operation_id,
  selected_paths:Object.keys(verified),
  structural_summaries:verified,
},null,2));
