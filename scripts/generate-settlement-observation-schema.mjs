import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';

const schemaPath='contracts/observation-evidence-v1/schema.json';
const defaultLinkmlPath='contracts/observation-evidence-v1/settlement-observation.linkml.yaml';

let mode='--check';
let linkmlPath=defaultLinkmlPath;
const args=process.argv.slice(2);
for(let index=0;index<args.length;index+=1){
  const arg=args[index];
  if(arg==='--check'||arg==='--write'){
    mode=arg;
    continue;
  }
  if(arg==='--source'){
    linkmlPath=args[index+1];
    if(!linkmlPath) throw new Error('--source requires a path');
    index+=1;
    continue;
  }
  throw new Error('usage: generate-settlement-observation-schema.mjs [--check|--write] [--source PATH]');
}

const python=`
import sys
from linkml.generators.jsonschemagen import JsonSchemaGenerator

schema_path = sys.argv[1]
generator = JsonSchemaGenerator(
    schema_path,
    top_class="SettlementObservation",
    include_null=False,
)
sys.stdout.write(generator.serialize())
`;

const result=spawnSync('python3',['-c',python,linkmlPath],{encoding:'utf8'});
if(result.error) throw result.error;
if(result.status!==0){
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status??1);
}

const generated=JSON.parse(result.stdout);
const defs=generated.$defs??generated.definitions??{};
const root=defs.SettlementObservation??generated;
assert.ok(root&&root.properties,'LinkML did not emit SettlementObservation properties');
assert.equal(root.type,'object','SettlementObservation must remain an object');
assert.equal(root.additionalProperties,false,'SettlementObservation must remain closed');
assert.ok(Array.isArray(root.required),'LinkML did not emit required fields');
assert.equal(
  Object.hasOwn(root.properties,'provider_evidence'),
  false,
  'provider_evidence must remain an explicit Overcenter overlay outside LinkML',
);

function normalizeProperty(name,property){
  if(name==='absence_evidence'){
    assert.equal(
      property.$ref,
      '#/$defs/AbsenceEvidenceEnvelope',
      'absence_evidence must remain a structural reference to the existing contract definition',
    );
    return {$ref:'#/$defs/AbsenceEvidenceEnvelope'};
  }

  if(Array.isArray(property.enum)) return {enum:[...property.enum]};

  if(property.$ref!==undefined){
    assert.equal(typeof property.$ref,'string',`${name} emitted an invalid $ref`);
    const definition=defs[property.$ref.split('/').at(-1)];
    assert.ok(definition,`${name} referenced a missing LinkML definition`);
    assert.ok(
      Array.isArray(definition.enum),
      `${name} emitted an unsupported non-enum reference: ${inspect(property,{depth:null,colors:false})}`,
    );
    return {enum:[...definition.enum]};
  }

  const structuralKeys=new Set(['type','minimum','maximum','pattern','minLength','maxLength']);
  const metadataKeys=new Set(['title','description']);
  const unsupported=Object.keys(property).filter(
    key=>!structuralKeys.has(key)&&!metadataKeys.has(key),
  );
  assert.deepEqual(
    unsupported,
    [],
    `${name} emitted unsupported structure: ${inspect(property,{depth:null,colors:false})}`,
  );

  const normalized={};
  for(const key of structuralKeys){
    if(property[key]!==undefined) normalized[key]=property[key];
  }
  assert.ok(
    Object.keys(normalized).length>0,
    `LinkML structural constraints missing for ${name}: ${inspect(property,{depth:null,colors:false})}`,
  );
  return normalized;
}

const properties={};
for(const [name,property] of Object.entries(root.properties)){
  properties[name]=normalizeProperty(name,property);
}
for(const name of root.required){
  assert.ok(Object.hasOwn(properties,name),`required LinkML property missing from projection: ${name}`);
}

// Deliberate Overcenter overlay. This ownership marker is repository-local
// contract metadata, not generic LinkML structure.
properties.provider_evidence={
  type:'object',
  additionalProperties:true,
  'x-overcenter-providerOwned':true,
};

const settlementObservation={
  type:root.type,
  additionalProperties:root.additionalProperties,
  required:[...root.required],
  properties,
};

const document=JSON.parse(readFileSync(schemaPath,'utf8'));
assert.ok(document.$defs?.SettlementObservation,'production SettlementObservation missing');

if(mode==='--check'){
  try{
    assert.deepEqual(document.$defs.SettlementObservation,settlementObservation);
  }catch{
    process.stderr.write(
      'SettlementObservation is not the projection of its LinkML source.\n'
      +'Expected generated definition:\n'
      +inspect(settlementObservation,{depth:null,colors:false})
      +'\nCurrent checked-in definition:\n'
      +inspect(document.$defs.SettlementObservation,{depth:null,colors:false})
      +'\n',
    );
    process.exit(1);
  }
  console.log('SettlementObservation matches pinned LinkML structural source');
  process.exit(0);
}

document.$defs.SettlementObservation=settlementObservation;
writeFileSync(schemaPath,JSON.stringify(document,null,2)+'\n');
console.log('Updated '+schemaPath+' from '+linkmlPath);
