import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const experimentDir=dirname(fileURLToPath(import.meta.url));
const repoRoot=resolve(experimentDir,'../..');
const runner=joinPath('experiments/codex-closed-loop/sandbox-runner.ts');

function joinPath(path) {
  return resolve(repoRoot,path);
}

function run(worker) {
  const result=spawnSync(process.execPath,[
    '--experimental-strip-types',
    runner,
    '--stage','single-useful-obligation',
    '--seed','stage-one-contract',
    '--worker',worker,
  ],{
    cwd:repoRoot,
    encoding:'utf8',
    timeout:30_000,
  });
  assert.equal(result.status,0,result.stderr);
  const lines=result.stdout.trim().split(/\n+/);
  return JSON.parse(lines.at(-1));
}

test('Stage 1 scripted control settles only after independent verification',()=>{
  const evidence=run('scripted-control');
  assert.equal(evidence.outcome,'accepted');
  assert.equal(evidence.capability_claim,'harness-only');
  assert.equal(evidence.authority.disposition,'DONE');
  assert.equal(evidence.authority.verified,true);
  assert.equal(evidence.authority.fresh_reconstruction_passed,true);
  assert.equal(evidence.metrics.verified_useful_transitions,1);
  assert.equal(evidence.metrics.false_done_count,0);
  assert.equal(evidence.metrics.unsafe_or_duplicate_provider_effects,0);
  assert.equal(evidence.metrics.human_judgment_interventions,0);
  assert.equal(evidence.metrics.observed_project_changes_outside_scope,0);
  assert.equal(evidence.promotion_evidence.eligible,false);
  assert.deepEqual(evidence.candidate.changed_paths,[
    'src/format.js',
    'src/format.ts',
    'src/index.js',
    'src/index.ts',
    'src/math.js',
    'src/math.ts',
  ]);
});

test('no-op worker cannot manufacture DONE',()=>{
  const evidence=run('noop-control');
  assert.equal(evidence.outcome,'rejected');
  assert.equal(evidence.authority.disposition,'READY');
  assert.equal(evidence.metrics.verified_useful_transitions,0);
  assert.equal(evidence.metrics.false_done_count,0);
  assert.equal(evidence.authority.fresh_reconstruction_passed,true);
});

test('Stage 1 runner has no provider-effect or publication path',()=>{
  const source=readFileSync(runner,'utf8');
  assert.doesNotMatch(source,/\.beginEffect\s*\(/);
  assert.doesNotMatch(source,/\.performEffect\s*\(/);
  assert.doesNotMatch(source,/api\.github\.com/);
  assert.doesNotMatch(source,/GITHUB_TOKEN|OPENAI_API_KEY/);
});
