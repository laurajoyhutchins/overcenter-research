import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import test from 'node:test';

const required=[
  '.github/workflows/production-criticality-mutation-probe.yml',
  '.github/workflows/promote-criticality-mutation-evidence.yml',
  'experiments/production-criticality-ranking/mutation-evidence.ts',
  'experiments/production-criticality-ranking/emit-mutation-evidence.ts',
  'experiments/production-criticality-ranking/verify-mutation-evidence-sources.ts',
];

test('checked-in hostile mutation evidence retains a live refresh path',()=>{
  assert.equal(existsSync('experiments/production-criticality-ranking/mutation-evidence.json'),true);
  assert.equal(existsSync('experiments/production-criticality-ranking/mutation-probes.json'),true);
  for(const path of required) {
    assert.equal(existsSync(path),true,`missing mutation-evidence refresh component: ${path}`);
  }
  const producer=readFileSync(required[0],'utf8');
  const promoter=readFileSync(required[1],'utf8');
  assert.match(producer,/continue-on-error:\s*true[\s\S]*verify-mutation-evidence-sources\.ts/);
  assert.match(producer,/forcing a full repair run/);
  assert.match(promoter,/workflow_run:/);
  assert.match(promoter,/Refresh criticality mutation evidence/);
});
