import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  type ObservationOperation,
  type OpenApiDocument,
} from './openapi.ts';
import {
  RESPONSE_SLICES,
  type ResponseFieldSpec,
} from './response-slice.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_REPOSITORY_OPERATION,
} from '../../src/providers/github-certified-repository.ts';
import {
  GITHUB_COMMIT_STATUSES_OPERATION,
} from '../../src/providers/github-certified-status.ts';
import {
  GITHUB_REF_OPERATION,
} from '../../src/providers/github-certified-ref.ts';
import {
  GITHUB_PULL_REQUEST_OPERATION,
} from '../../src/providers/github-certified-pr.ts';

const schemaPath=process.argv[2];
if (!schemaPath) throw new Error('usage: verify-kernel-github-contract.ts <openapi.json>');

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
  for (const key of ['type','nullable','enum','minLength','maxLength','minimum','maximum'] as const) {
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
  if (!schema) throw new Error(`RESPONSE_SCHEMA_MISSING:${operation.operation_id}`);
  const candidates=pathSchemas(schema,path);
  if (candidates.length===0) throw new Error(`RESPONSE_SCHEMA_PATH_MISSING:${operation.operation_id}:${path}`);
  return candidates
    .map(candidate=>JSON.stringify(structuralSummary(candidate)))
    .sort();
}

function parameterSummaries(operation:ObservationOperation):unknown[] {
  return operation.parameters.map(parameter=>[
    parameter.in,
    parameter.name,
    parameter.required,
    structuralSummary(parameter.schema),
  ]);
}

function verifyOperation({
  pathTemplate,
  generated,
  fields,
}:{
  pathTemplate:string;
  generated:ObservationOperation;
  fields:readonly ResponseFieldSpec[];
}):{
  operation_id:string;
  selected_paths:Record<string,string[]>;
} {
  const pinned=deriveObservationOperation(document,{
    apiVersion:GITHUB_API_VERSION,
    method:'get',
    pathTemplate,
  });

  assert.equal(pinned.operation_id,generated.operation_id);
  assert.equal(pinned.path_template,generated.path_template);
  assert.equal(pinned.method,generated.method);
  assert.deepEqual(
    parameterSummaries(generated),
    parameterSummaries(pinned),
    `GENERATED_REQUEST_CONTRACT_DRIFT:${generated.operation_id}`,
  );

  const verified:Record<string,string[]>={};
  for (const field of fields) {
    const expected=summaries(pinned,field.path);
    const actual=summaries(generated,field.path);
    assert.deepEqual(
      actual,
      expected,
      `GENERATED_RESPONSE_SCHEMA_DRIFT:${generated.operation_id}:${field.path}`,
    );
    verified[field.path]=actual;
  }

  return {
    operation_id:pinned.operation_id,
    selected_paths:verified,
  };
}

const repository=verifyOperation({
  pathTemplate:'/repos/{owner}/{repo}',
  generated:GITHUB_REPOSITORY_OPERATION,
  fields:RESPONSE_SLICES['repos/get'],
});

const ref=verifyOperation({
  pathTemplate:'/repos/{owner}/{repo}/git/ref/{ref}',
  generated:GITHUB_REF_OPERATION,
  fields:RESPONSE_SLICES['git/get-ref'],
});

const pullRequest=verifyOperation({
  pathTemplate:'/repos/{owner}/{repo}/pulls/{pull_number}',
  generated:GITHUB_PULL_REQUEST_OPERATION,
  fields:RESPONSE_SLICES['pulls/get'],
});

const statuses=verifyOperation({
  pathTemplate:'/repos/{owner}/{repo}/commits/{ref}/statuses',
  generated:GITHUB_COMMIT_STATUSES_OPERATION,
  fields:RESPONSE_SLICES['repos/list-commit-statuses-for-ref'],
});

console.log(JSON.stringify({
  schema_sha256:actualDigest,
  operations:[repository,ref,pullRequest,statuses],
},null,2));
