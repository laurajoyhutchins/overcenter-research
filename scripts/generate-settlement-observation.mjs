import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {contractPackage,repositoryRoot} from './contract-package.mjs';

const observationContract=contractPackage('observation-evidence');
const schemaPath=join(observationContract,'schema.json');
const generatedPath=join(repositoryRoot,'src/generated/settlement-observation-schema.ts');
const generatedTypePath=join(repositoryRoot,'src/generated/settlement-observation-type.ts');
const defaultSource=join(observationContract,'settlement-observation.typebox.ts');
const sourceLabel=relative(repositoryRoot,defaultSource).replaceAll('\\','/');
const generatedTypeSource=relative(dirname(generatedTypePath),defaultSource).replaceAll('\\','/');
const generatedTypeImport=generatedTypeSource.startsWith('.')?generatedTypeSource:`./${generatedTypeSource}`;

let mode='--check';
let sourcePath=defaultSource;
const args=process.argv.slice(2);
for (let index=0;index<args.length;index+=1) {
  const arg=args[index];
  if (arg==='--check'||arg==='--write') {
    mode=arg;
    continue;
  }
  if (arg==='--source') {
    sourcePath=args[index+1];
    if (!sourcePath) throw new Error('--source requires a path');
    index+=1;
    continue;
  }
  throw new Error('usage: generate-settlement-observation.mjs [--check|--write] [--source PATH]');
}

const sourceUrl=pathToFileURL(resolve(sourcePath)).href;
const {SettlementObservation}=await import(sourceUrl);
const projected=JSON.parse(JSON.stringify(SettlementObservation));

assert.equal(projected.type,'object','SettlementObservation must remain an object');
assert.equal(projected.additionalProperties,false,'SettlementObservation must remain closed');
assert.deepEqual(projected.required,['verifier','mutation_certainty']);
assert.equal(
  projected.properties.absence_evidence.$ref,
  '#/$defs/AbsenceEvidenceEnvelope',
  'absence evidence must remain externally owned',
);
assert.equal(
  projected.properties.provider_evidence['x-overcenter-providerOwned'],
  true,
  'provider evidence ownership marker must remain explicit',
);

const generated=`// Generated from ${sourceLabel}.
// Do not edit by hand.
export const SettlementObservationSchema=${JSON.stringify(projected,null,2)} as const;
`;
const generatedType=`// Generated from ${sourceLabel}.
// Do not edit by hand.
export type {Observation} from '${generatedTypeImport}';
`;

const document=JSON.parse(readFileSync(schemaPath,'utf8'));
assert.ok(document.$defs?.SettlementObservation,'production SettlementObservation missing');

if (mode==='--check') {
  try {
    assert.deepEqual(document.$defs.SettlementObservation,projected);
    assert.equal(readFileSync(generatedPath,'utf8'),generated);
    assert.equal(readFileSync(generatedTypePath,'utf8'),generatedType);
  } catch {
    process.stderr.write(
      'SettlementObservation projections are stale for '+sourcePath+'\n'
      +'Expected definition:\n'+JSON.stringify(projected,null,2)+'\n',
    );
    process.exit(1);
  }
  console.log('SettlementObservation projections match TypeBox structural source');
  process.exit(0);
}

document.$defs.SettlementObservation=projected;
writeFileSync(schemaPath,JSON.stringify(document,null,2)+'\n');
writeFileSync(generatedPath,generated);
writeFileSync(generatedTypePath,generatedType);
console.log('Updated SettlementObservation projections from '+sourcePath);
