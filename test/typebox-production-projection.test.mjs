import assert from 'node:assert/strict';
import {readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {contractPackage} from '../scripts/contract-package.mjs';

const contractDir=contractPackage('observation-evidence');
const source=join(contractDir,'settlement-observation.typebox.ts');
const generator='scripts/generate-settlement-observation.mjs';
const original=readFileSync(source,'utf8');

function rejected(name,mutate,needle){
  const path=join(contractDir,'.settlement-observation-'+name+'.typebox.ts');
  const changed=mutate(original);
  assert.notEqual(changed,original,name+' mutation did not modify the source fixture');
  writeFileSync(path,changed);
  try {
    const result=spawnSync(
      process.execPath,
      ['--experimental-strip-types',generator,'--check','--source',path],
      {encoding:'utf8'},
    );
    assert.notEqual(result.status,0,name+' mutation was silently accepted');
    assert.match(result.stderr,new RegExp(needle));
  } finally {
    rmSync(path,{force:true});
  }
}

test('projection fails closed on source-only structural mutations',()=>{
  rejected(
    'field',
    source=>source.replace(
      "  observation_error:Type.Optional(Type.String()),",
      "  observation_error:Type.Optional(Type.String()),\n  observer_generation:Type.Optional(Type.Integer()),",
    ),
    'observer_generation',
  );
  rejected(
    'enum',
    source=>source.replace(
      "  'kubernetes-configmap-exists/v1',",
      "  'kubernetes-configmap-exists/v1',\n  'hostile-verifier/v1',",
    ),
    'hostile-verifier',
  );
  rejected(
    'bound',
    source=>source.replace(
      '    maximum:Number.MAX_SAFE_INTEGER,',
      '    maximum:10,',
    ),
    '"maximum": 10',
  );
});
