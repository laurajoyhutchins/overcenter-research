import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { validateObservationEnvelope } from '../../src/observation.ts';

const ROOT='experiments/linkml-contract-refactor';
const ONTOLOGY=`${ROOT}/ontology.yaml`;
const TARGET='SettlementObservationScalarSlice';
const OPEN_FIELDS=new Set(['absence_evidence','provider_evidence']);
const NEW_FIELD='observer_generation';

const productionSchema=JSON.parse(
  readFileSync('contracts/observation-evidence-v1/schema.json','utf8'),
);
const modelText=readFileSync('src/model.ts','utf8');
const validatorText=readFileSync('src/observation.ts','utf8');

function invoke(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8'});
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function generateJsonSchema(schemaPath) {
  const python=`
import sys
from linkml.generators.jsonschemagen import JsonSchemaGenerator
generator = JsonSchemaGenerator(
    sys.argv[1],
    top_class="${TARGET}",
    include_null=False,
)
sys.stdout.write(generator.serialize())
`;
  return JSON.parse(invoke('python3',['-c',python,schemaPath]));
}

function generate(schemaPath) {
  return {
    jsonSchema:generateJsonSchema(schemaPath),
    typescript:invoke('gen-typescript',[schemaPath]),
  };
}

function sorted(values) {
  return [...values].sort();
}

function signature(fields,required) {
  return {fields:sorted(fields),required:sorted(required)};
}

function withoutOpen(values) {
  return new Set([...values].filter((value)=>!OPEN_FIELDS.has(value)));
}

function schemaSignature(document,className=TARGET) {
  let root=document.$defs?.[className] ?? document;
  if (root.$ref) {
    const name=root.$ref.split('/').at(-1);
    root=document.$defs?.[name] ?? root;
  }
  assert.ok(root.properties,`JSON Schema root for ${className} has no properties`);
  return signature(
    new Set(Object.keys(root.properties)),
    new Set(root.required ?? []),
  );
}

function interfaceBody(source,name) {
  const match=source.match(
    new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(match,`interface ${name} not found`);
  return match[1];
}

function interfaceSignature(source,name) {
  const body=interfaceBody(source,name);
  const fields=new Set();
  const required=new Set();
  const pattern=/^\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:/gm;
  let member;
  while ((member=pattern.exec(body))!==null) {
    fields.add(member[1]);
    if (!member[2]) required.add(member[1]);
  }
  return signature(fields,required);
}

function interfaceFieldType(source,name,field) {
  const body=interfaceBody(source,name);
  const match=body.match(new RegExp(`^\\s*${field}\\??\\s*:\\s*([^,\\n]+)`,'m'));
  assert.ok(match,`interface field missing: ${name}.${field}`);
  return match[1].trim();
}

function enumValues(document,property) {
  if (Array.isArray(property.enum)) return property.enum;
  if (property.$ref) {
    const name=property.$ref.split('/').at(-1);
    const definition=document.$defs?.[name];
    assert.ok(definition,`enum definition missing: ${name}`);
    return definition.enum;
  }
  throw new Error('property has no enum or enum reference');
}

function stringLiterals(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match)=>match[1]);
}

function validatorSignature(source) {
  const start=source.indexOf('export function validateObservationEnvelope');
  const end=source.indexOf('\nfunction readLocalFile',start);
  assert.ok(start>=0 && end>start,'observation validator body not found');
  const body=source.slice(start,end);
  const requiredMatch=body.match(/const required=\[([\s\S]*?)\];/);
  const optionalMatch=body.match(/const optional=\[([\s\S]*?)\];/);
  assert.ok(requiredMatch && optionalMatch,'validator field lists not found');
  const required=new Set(stringLiterals(requiredMatch[1]));
  const optional=new Set(stringLiterals(optionalMatch[1]));
  return signature(new Set([...required,...optional]),required);
}

function productionSignatures() {
  const schema=productionSchema.$defs.SettlementObservation;
  const schemaSig=signature(
    withoutOpen(new Set(Object.keys(schema.properties))),
    withoutOpen(new Set(schema.required ?? [])),
  );
  const model=interfaceSignature(modelText,'Observation');
  const modelSig=signature(
    withoutOpen(new Set(model.fields)),
    withoutOpen(new Set(model.required)),
  );
  const validator=validatorSignature(validatorText);
  const validatorSig=signature(
    withoutOpen(new Set(validator.fields)),
    withoutOpen(new Set(validator.required)),
  );
  return {schema:schemaSig,model:modelSig,validator:validatorSig};
}

function addOptionalField(sig,name) {
  return signature(new Set([...sig.fields,name]),new Set(sig.required));
}

function allAgree(signatures) {
  const values=Object.values(signatures).map((value)=>JSON.stringify(value));
  return new Set(values).size===1;
}

test('current production field vocabulary and requiredness agree before mutation',()=>{
  const current=productionSignatures();
  assert.deepEqual(current.model,current.schema);
  assert.deepEqual(current.validator,current.schema);
});

test('LinkML faithfully reproduces the tested production JSON Schema semantics',()=>{
  invoke('linkml-validate',[ONTOLOGY]);
  const generated=generateJsonSchema(ONTOLOGY);
  const root=generated.$defs?.[TARGET] ?? generated;
  const current=productionSchema.$defs.SettlementObservation;

  assert.deepEqual(schemaSignature(generated),productionSignatures().schema);
  assert.deepEqual(
    enumValues(generated,root.properties.verifier),
    current.properties.verifier.enum,
  );
  assert.deepEqual(
    enumValues(generated,root.properties.mutation_certainty),
    current.properties.mutation_certainty.enum,
  );
  assert.deepEqual(
    enumValues(generated,root.properties.provider),
    current.properties.provider.enum,
  );
  assert.equal(root.properties.path.type,'string');
  assert.equal(root.properties.repository_id.type,'integer');
  assert.equal(root.properties.repository_id.minimum,1);
  assert.equal(root.properties.repository_id.maximum,Number.MAX_SAFE_INTEGER);
});

test('stock LinkML TypeScript generation widens production enum fields',()=>{
  const generated=generate(ONTOLOGY).typescript;

  assert.equal(interfaceFieldType(generated,TARGET,'verifier'),'string');
  assert.equal(interfaceFieldType(generated,TARGET,'mutation_certainty'),'string');
  assert.equal(interfaceFieldType(generated,TARGET,'provider'),'string');

  const production=interfaceBody(modelText,'Observation');
  assert.match(production,/verifier:\s*Postcondition\['verifier'\]/);
  assert.match(production,/mutation_certainty:\s*MutationCertainty/);
  assert.match(production,/provider\?:\s*'github'\s*\|\s*'kubernetes'/);
});

test('one LinkML edit moves generated field vocabulary together but does not fix TypeScript enum fidelity',()=>{
  const original=readFileSync(ONTOLOGY,'utf8');
  const anchor=`      observation_error:
        range: string
`;
  assert.ok(original.includes(anchor),'ontology refactor anchor changed');
  const changed=original.replace(
    anchor,
    anchor+`      observer_generation:
        range: integer
`,
  );

  const dir=mkdtempSync(join(tmpdir(),'overcenter-linkml-refactor-'));
  const path=join(dir,'ontology.yaml');
  try {
    writeFileSync(path,original);
    const before=generate(path);
    writeFileSync(path,changed);
    const after=generate(path);

    const beforeSchema=schemaSignature(before.jsonSchema);
    const afterSchema=schemaSignature(after.jsonSchema);
    const beforeTypes=interfaceSignature(before.typescript,TARGET);
    const afterTypes=interfaceSignature(after.typescript,TARGET);

    assert.equal(beforeSchema.fields.includes(NEW_FIELD),false);
    assert.equal(beforeTypes.fields.includes(NEW_FIELD),false);
    assert.equal(afterSchema.fields.includes(NEW_FIELD),true);
    assert.equal(afterTypes.fields.includes(NEW_FIELD),true);
    assert.equal(afterSchema.required.includes(NEW_FIELD),false);
    assert.equal(afterTypes.required.includes(NEW_FIELD),false);
    assert.equal(
      interfaceFieldType(after.typescript,TARGET,'observer_generation'),
      'number',
    );
    assert.equal(interfaceFieldType(after.typescript,TARGET,'verifier'),'string');
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test('the real runtime validator remains an independent manifestation',()=>{
  const current={
    verifier:'github-commit-status/v2',
    mutation_certainty:'uncertain',
    provider:'github',
    repository_id:1,
    repository_full_name:'owner/repo',
    commit_sha:'0123456789abcdef0123456789abcdef01234567',
    context:'overcenter/example',
    expected_state:'success',
  };
  assert.doesNotThrow(()=>validateObservationEnvelope(current));
  assert.throws(
    ()=>validateObservationEnvelope({...current,[NEW_FIELD]:1}),
    /OBSERVATION_UNKNOWN_FIELD:observer_generation/,
  );
});

test('faithful stock-LinkML path does not reduce independently maintained manifestations',()=>{
  const current=productionSignatures();
  const partiallyUpdated={
    schema:addOptionalField(current.schema,NEW_FIELD),
    model:addOptionalField(current.model,NEW_FIELD),
    validator:current.validator,
  };
  assert.equal(allAgree(partiallyUpdated),false);

  const metrics={
    current_independent_structural_manifestations:3,
    faithful_stock_linkml_independent_structural_manifestations:3,
    generated_json_schema_manifestations:1,
    stock_typescript_faithful:false,
    reduction_in_independent_manifestations:0,
  };
  console.log('maintenance surface',JSON.stringify(metrics));
  assert.equal(metrics.current_independent_structural_manifestations,3);
  assert.equal(metrics.faithful_stock_linkml_independent_structural_manifestations,3);
  assert.equal(metrics.stock_typescript_faithful,false);
});
