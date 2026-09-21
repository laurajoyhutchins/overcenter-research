import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

function run(worker,extra=[]) {
  const result=spawnSync(process.execPath,[
    '--experimental-strip-types',
    runner,
    '--stage','single-useful-obligation',
    '--seed','stage-one-contract',
    '--worker',worker,
    ...extra,
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

test('recorded uncertain-model candidate is independently accepted and remains non-promotable',()=>{
  const witness=joinPath('experiments/codex-closed-loop/model-witness');
  const evidence=run('recorded-model',[
    '--candidate',resolve(witness,'candidate.json'),
    '--provenance',resolve(witness,'provenance.json'),
  ]);
  assert.equal(evidence.outcome,'accepted');
  assert.equal(evidence.capability_claim,'uncertain-reasoning-stage1');
  assert.equal(evidence.worker.reasoning_provider,'openai-codex-cloud');
  assert.equal(evidence.worker.reasoning_transport,'github-pr-comment');
  assert.equal(evidence.worker.repository_mutation_observed,false);
  assert.equal(evidence.worker.reasoning_process_confinement_proven,false);
  assert.equal(evidence.authority.disposition,'DONE');
  assert.equal(evidence.authority.verified,true);
  assert.equal(evidence.authority.fresh_reconstruction_passed,true);
  assert.equal(evidence.metrics.verified_useful_transitions,1);
  assert.equal(evidence.metrics.false_done_count,0);
  assert.equal(evidence.metrics.human_judgment_interventions,0);
  assert.equal(evidence.promotion_evidence.eligible,false);
});

test('recorded model provenance binds exact retained prompt, response, and candidate bytes',()=>{
  const witness=joinPath('experiments/codex-closed-loop/model-witness');
  const provenance=JSON.parse(readFileSync(resolve(witness,'provenance.json'),'utf8'));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(readFileSync(resolve(witness,'prompt.txt'))),provenance.prompt_sha256);
  assert.equal(hash(readFileSync(resolve(witness,'candidate.json'))),provenance.candidate_sha256);
  assert.equal(hash(readFileSync(resolve(witness,'response.txt'))),provenance.response_body_sha256);
  assert.equal(provenance.branch_head_before_request,provenance.branch_head_after_response);
  assert.equal(provenance.repository_mutation_observed,false);
});
