import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from '../src/providers/github-contract.ts';
import {
  deriveGithubObservationOperation,
  type GithubOpenApiDocument,
  type JsonObject,
} from '../src/providers/github-openapi.ts';
import { GITHUB_OPERATION_SEMANTICS } from '../src/providers/github-semantics.ts';

const schemaPath=process.argv[2];
const outputPath=process.argv[3]??'src/providers/github-operations.generated.ts';
if (!schemaPath) throw new Error('usage: generate-github-operations.ts <api.github.com.json> [output.ts]');

const source=readFileSync(schemaPath,'utf8');
const digest=createHash('sha256').update(source).digest('hex');
if (digest!==GITHUB_OPENAPI_SHA256) {
  throw new Error(`GITHUB_OPENAPI_SCHEMA_DIGEST_MISMATCH:${digest}`);
}
const document=JSON.parse(source) as GithubOpenApiDocument;

function object(value:unknown):JsonObject|null {
  return value!==null && typeof value==='object' && !Array.isArray(value)?value as JsonObject:null;
}

function resolveRef(value:unknown):unknown {
  let current=value;
  const seen=new Set<string>();
  while (true) {
    const ref=object(current)?.$ref;
    if (typeof ref!=='string') return current;
    if (!ref.startsWith('#/')) throw new Error(`GITHUB_OPENAPI_EXTERNAL_REF_UNSUPPORTED:${ref}`);
    if (seen.has(ref)) throw new Error(`GITHUB_OPENAPI_REF_CYCLE:${ref}`);
    seen.add(ref);
    let resolved:unknown=document;
    for (const segment of ref.slice(2).split('/')) {
      const body=object(resolved);
      if (!body || !Object.hasOwn(body,segment)) throw new Error(`GITHUB_OPENAPI_REF_NOT_FOUND:${ref}`);
      resolved=body[segment];
    }
    current=resolved;
  }
}

function pathTree(paths:readonly string[]):JsonObject {
  const root:JsonObject={};
  for (const path of paths) {
    let cursor=root;
    for (const segment of path.split('.').filter(Boolean)) {
      if (segment==='[]') {
        const items=object(cursor['[]'])??{};
        cursor['[]']=items;
        cursor=items;
        continue;
      }
      const arrayProperty=segment.endsWith('[]');
      const name=arrayProperty?segment.slice(0,-2):segment;
      const next=object(cursor[name])??{};
      cursor[name]=next;
      cursor=next;
      if (arrayProperty) {
        const items=object(cursor['[]'])??{};
        cursor['[]']=items;
        cursor=items;
      }
    }
  }
  return root;
}

function propertySchema(schema:unknown,name:string):unknown {
  const current=object(resolveRef(schema));
  const properties=object(current?.properties);
  if (properties && Object.hasOwn(properties,name)) return properties[name];
  for (const keyword of ['allOf','anyOf','oneOf']) {
    const branches=current?.[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found=propertySchema(branch,name);
      if (found!==undefined) return found;
    }
  }
  return undefined;
}

function itemSchema(schema:unknown):unknown {
  const current=object(resolveRef(schema));
  if (current && Object.hasOwn(current,'items')) return current.items;
  for (const keyword of ['allOf','anyOf','oneOf']) {
    const branches=current?.[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found=itemSchema(branch);
      if (found!==undefined) return found;
    }
  }
  return undefined;
}

function leafSchema(schema:unknown):unknown {
  const current=object(resolveRef(schema));
  if (!current) return schema;
  const result:JsonObject={};
  for (const key of ['type','enum','nullable','minLength','maxLength','minimum','maximum','format']) {
    if (Object.hasOwn(current,key)) result[key]=current[key];
  }
  for (const keyword of ['allOf','anyOf','oneOf']) {
    const branches=current[keyword];
    if (Array.isArray(branches)) result[keyword]=branches.map(leafSchema);
  }
  return result;
}

function sliceSchema(schema:unknown,tree:JsonObject):unknown {
  const keys=Object.keys(tree);
  if (keys.length===0) return leafSchema(schema);
  if (keys.length===1 && keys[0]==='[]') {
    const items=itemSchema(schema);
    if (items===undefined) throw new Error('GITHUB_OPENAPI_RESPONSE_ARRAY_ITEMS_MISSING');
    return {type:'array',items:sliceSchema(items,object(tree['[]'])??{})};
  }

  const properties:JsonObject={};
  for (const key of keys) {
    if (key==='[]') throw new Error('GITHUB_OPENAPI_RESPONSE_SLICE_INVALID');
    const property=propertySchema(schema,key);
    if (property===undefined) throw new Error(`GITHUB_OPENAPI_RESPONSE_PATH_NOT_FOUND:${key}`);
    properties[key]=sliceSchema(property,object(tree[key])??{});
  }
  return {type:'object',properties};
}

function constantName(name:string):string {
  return `GITHUB_${name.toUpperCase()}_OPERATION`;
}

const operations=Object.entries(GITHUB_OPERATION_SEMANTICS).map(([key,semantic])=>{
  const operation=deriveGithubObservationOperation(document,semantic.operation_id,GITHUB_API_VERSION);
  if (operation.github_extensions.enabledForGitHubApps!==true) {
    throw new Error(`GITHUB_OPERATION_NOT_GITHUB_APP_ENABLED:${semantic.operation_id}`);
  }
  const success=operation.outcomes.find(outcome=>outcome.status==='200');
  if (!success?.schema) throw new Error(`GITHUB_OPENAPI_200_SCHEMA_MISSING:${semantic.operation_id}`);
  return [key,constantName(key),{
    ...operation,
    outcomes:[{
      ...success,
      schema:sliceSchema(success.schema,pathTree(semantic.response_slice.map(field=>field.path))),
    }],
  }] as const;
});

const generated=[
  '// GENERATED FILE. DO NOT EDIT.',
  `// Source: github/rest-api-description@${GITHUB_OPENAPI_SOURCE_COMMIT}`,
  `// SHA-256: ${GITHUB_OPENAPI_SHA256}`,
  "import type { GithubObservationOperation } from './github-openapi.ts';",
  '',
  ...operations.flatMap(([,name,operation])=>[
    `export const ${name}:GithubObservationOperation=${JSON.stringify(operation)};`,
    '',
  ]),
  'export const GITHUB_OBSERVATION_OPERATIONS={',
  ...operations.map(([key,name])=>`  ${key}:${name},`),
  '} as const;',
  '',
].join('\n');

writeFileSync(outputPath,generated);
