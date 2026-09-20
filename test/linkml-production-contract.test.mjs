import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const sourcePath='contracts/observation-evidence-v1/settlement-observation.linkml.yaml';
const generatorPath='scripts/generate-settlement-observation-schema.mjs';

test('a new LinkML field cannot disappear behind projection plumbing',()=>{
  const source=readFileSync(sourcePath,'utf8');
  const marker=`      observation_error:
        range: string
`;
  assert.ok(source.includes(marker),'SettlementObservation mutation marker changed');
  const mutated=source.replace(
    marker,
    marker+`      observer_generation:
        range: integer
`,
  );

  const dir=mkdtempSync(join(tmpdir(),'overcenter-linkml-production-'));
  const path=join(dir,'settlement-observation.linkml.yaml');
  try{
    writeFileSync(path,mutated);
    const result=spawnSync(
      process.execPath,
      [generatorPath,'--check','--source',path],
      {encoding:'utf8'},
    );
    assert.notEqual(
      result.status,
      0,
      'a new canonical LinkML property was silently ignored by the production projection',
    );
    assert.match(
      result.stderr,
      /observer_generation/,
      'projection failure did not expose the new canonical field',
    );
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
