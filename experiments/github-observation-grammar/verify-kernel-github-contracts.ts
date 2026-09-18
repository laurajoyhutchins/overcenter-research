import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  type ObservationOperation,
  type OpenApiDocument,
} from './openapi.ts';
import {
  GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
  GITHUB_COMMIT_STATUSES_OPERATION,
} from '../../src/providers/github-certified-status.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
} from '../../src/providers/github-contract.ts';
import {
  GITHUB_GET_REF_OPERATION,
  GITHUB_REF_RESPONSE_SLICE,
} from '../../src/providers/github-certified-ref.ts';
import {
  GITHUB_GET_REPOSITORY_OPERATION,
  GITHUB_REPOSITORY_RESPONSE_SLICE,
} from '../../src/providers/github-certified-repository.ts';
import type {
  ResponseFieldSpec,
  StructuralOperation,
} from '../../src/provider-observation/response-slice.ts';

const schemaPath=process.argv[2];
if (!schemaPath) throw new Error('usage: verify-kernel-github-contracts.ts <openapi.json>');

const bytes=readFileSync(schemaPath);
const actualDigest=createHash('sha256').update(bytes).digest('hex');
assert.equal(actualDigest,GITHUB_OPENAPI_SHA256,'PINNED_OPENAPI_DIGEST_MISMATCH');

const document=JSON.parse(bytes.toString('utf8')) as OpenApiDocument;

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

function summaries(
  operation:Pick<StructuralOperation,'operation_id'|'outcomes'>,
  path:string,
):string[] {
  const schema=operation.outcomes.find(outcome=>outcome.status==='200')?.schema;
  if (!schema) throw new Error(`GITHUB_SCHEMA_MISSING:${operation.operation_id}`);
  const candidates=pathSchemas(schema,path);
  if (candidates.length===0) throw new Error(`GITHUB_SCHEMA_PATH_MISSING:${operation.operation_id}:${path}`);
  return candidates
    .map(candidate=>JSON.stringify(structuralSummary(candidate)))
    .sort();
}

function verifyOperation({
  pinned,
  generated,
  fields,
}:{
  pinned:ObservationOperation;
  generated:StructuralOperation & {
    method:string;
    path_template:string;
    parameters:Array<{in:string;name:string;required:boolean}>;
  };
  fields:readonly ResponseFieldSpec[];
}) {
  assert.equal(pinned.operation_id,generated.operation_id);
  assert.equal(pinned.path_template,generated.path_template);
  assert.equal(pinned.method,generated.method);
  const parameterKey=(parameter:{in:string;name:string;required:boolean})=>
    `${parameter.in}:\0${parameter.name}:\0${String(parameter.required)}`;
  assert.deepEqual(
    pinned.parameters.map(parameterKey).sort(),
    generated.parameters.map(parameterKey).sort(),
  );

  const verified:Record<string,string[]>={};
  for (const field of fields) {
    const expected=summaries(pinned,field.path);
    const actual=summaries(generated,field.path);
    assert.deepEqual(
      actual,
      expected,
      `GENERATED_GITHUB_SCHEMA_DRIFT:${generated.operation_id}:${field.path}`,
    );
    verified[field.path]=actual;
  }
  return verified;
}

const pinnedRepository=deriveObservationOperation(document,{
  apiVersion:GITHUB_API_VERSION,
  method:'get',
  pathTemplate:'/repos/{owner}/{repo}',
});
const pinnedStatus=deriveObservationOperation(document,{
  apiVersion:GITHUB_API_VERSION,
  method:'get',
  pathTemplate:'/repos/{owner}/{repo}/commits/{ref}/statuses',
});
const pinnedRef=deriveObservationOperation(document,{
  apiVersion:GITHUB_API_VERSION,
  method:'get',
  pathTemplate:'/repos/{owner}/{repo}/git/ref/{ref}',
});

const repositoryVerified=verifyOperation({
  pinned:pinnedRepository,
  generated:GITHUB_GET_REPOSITORY_OPERATION,
  fields:GITHUB_REPOSITORY_RESPONSE_SLICE,
});
const statusVerified=verifyOperation({
  pinned:pinnedStatus,
  generated:GITHUB_COMMIT_STATUSES_OPERATION,
  fields:GITHUB_COMMIT_STATUS_RESPONSE_SLICE,
});
const refVerified=verifyOperation({
  pinned:pinnedRef,
  generated:GITHUB_GET_REF_OPERATION,
  fields:GITHUB_REF_RESPONSE_SLICE,
});

console.log(JSON.stringify({
  schema_sha256:actualDigest,
  operations:{
    [pinnedRepository.operation_id]:{
      selected_paths:Object.keys(repositoryVerified),
      structural_summaries:repositoryVerified,
    },
    [pinnedStatus.operation_id]:{
      selected_paths:Object.keys(statusVerified),
      structural_summaries:statusVerified,
    },
    [pinnedRef.operation_id]:{
      selected_paths:Object.keys(refVerified),
      structural_summaries:refVerified,
    },
  },
},null,2));
