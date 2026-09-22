import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root = new URL('.', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', root), 'utf8'));

function patchBytes(relativePath) {
  const text = readFileSync(new URL(relativePath, root), 'utf8');
  assert.ok(text.startsWith('diff --git '), relativePath + ' is not an exact patch artifact');
  return text;
}

test('full Flask candidate corpus satisfies preregistered artifact admission', () => {
  assert.equal(corpus.schema, 'overcenter-code-graph-verification-corpus/v1');
  assert.equal(corpus.benchmark_slice.dataset, 'SWE-bench/SWE-bench');
  assert.equal(corpus.benchmark_slice.filter.repo, 'pallets/flask');
  assert.equal(corpus.benchmark_slice.expected_instances, 11);
  assert.equal(corpus.cases.length, 11);

  assert.equal(corpus.primary_thresholds.recall_min, 0.99);
  assert.equal(corpus.primary_thresholds.selected_fraction_max, 0.30);
  assert.equal(corpus.primary_thresholds.missed_regressions_max, 0);

  let human = 0;
  let ai = 0;
  let nonidenticalAi = 0;
  let unsuccessfulOrRegressiveAi = 0;
  let unresolvedOrErrorAi = 0;

  for (const c of corpus.cases) {
    assert.match(c.base_commit, /^[0-9a-f]{40}$/);
    patchBytes(c.test_patch);

    const humans = c.variants.filter(v => v.primary && v.authorship === 'human');
    assert.equal(humans.length, 1, c.id + ' must have exactly one primary human gold patch');
    assert.equal(humans[0].id, 'human-gold');

    const humanBytes = patchBytes(humans[0].patch);
    human += 1;

    for (const v of c.variants) {
      assert.equal(v.primary, true);
      assert.ok(v.provenance?.source);
      assert.ok(v.equivalence_group);

      const bytes = patchBytes(v.patch);
      const touched = [...bytes.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
      assert.ok(
        touched.every(path => path !== 'tests' && !path.startsWith('tests/')),
        c.id + '/' + v.id + ' modifies held-out tests',
      );
      if (v.authorship !== 'ai') continue;

      ai += 1;
      if (bytes !== humanBytes) nonidenticalAi += 1;

      const state = v.evaluation?.state;
      const regressed = (v.evaluation?.pass_to_pass_failure ?? 0) > 0;
      if (state === 'unresolved' || regressed) unsuccessfulOrRegressiveAi += 1;
      if (state === 'unresolved' || state === 'error') unresolvedOrErrorAi += 1;
    }
  }

  const admission = corpus.confirmatory_admission;
  assert.ok(human >= admission.human_exact_patches_min, JSON.stringify({human, admission}));
  assert.ok(ai >= admission.ai_exact_patches_min, JSON.stringify({ai, admission}));
  assert.ok(
    nonidenticalAi >= admission.ai_nonidentical_to_human_min,
    JSON.stringify({nonidenticalAi, admission}),
  );
  assert.ok(
    unsuccessfulOrRegressiveAi >= admission.ai_unsuccessful_or_regressive_exact_patches_min,
    JSON.stringify({unsuccessfulOrRegressiveAi, admission}),
  );

  assert.equal(human, corpus.confirmatory_design.human_variants);
  assert.equal(ai, corpus.confirmatory_design.ai_variants);
  assert.equal(corpus.confirmatory_design.frozen_before_confirmatory_execution, true);
  assert.ok(unresolvedOrErrorAi >= 2);
});

test('static frontier predictor distinguishes affected and unrelated tests', () => {
  const result = spawnSync(
    'python3',
    [new URL('frontier.py', root).pathname, 'self-test'],
    {encoding: 'utf8'},
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(report.score.recall, 1);
  assert.equal(report.score.reduction, 0.5);
});

test('known regression-bearing AI variants remain explicit adversarial cases', () => {
  const byId = new Map(corpus.cases.map(c => [c.id, c]));

  for (const [id, minimumRegressions] of [
    ['pallets__flask-4992', 2],
    ['pallets__flask-5063', 54],
  ]) {
    const c = byId.get(id);
    assert.ok(c, id + ' missing');
    const variant = c.variants.find(v => v.id === 'ai-qwen32-direct');
    assert.ok(variant, id + ' qwen32 adversarial patch missing');
    assert.equal(variant.evaluation.state, 'unresolved');
    assert.ok(
      variant.evaluation.pass_to_pass_failure >= minimumRegressions,
      id + ' lost its recorded regression evidence',
    );
  }
});

test('unreproducible AI outcomes stay outside the primary corpus', () => {
  assert.ok(corpus.documented_ai_cases.length >= 1);
  for (const c of corpus.documented_ai_cases) {
    assert.equal(c.primary, false);
    assert.equal(c.exclusion_reason, 'exact_patch_artifact_not_pinned');
  }
});


test('experiment lifecycle scripts parse and expose help without side effects', () => {
  for (const name of ['prepare.py', 'preflight.py', 'score.py', 'summarize.py']) {
    const result = spawnSync(
      'python3',
      [new URL(name, root).pathname, '--help'],
      {encoding: 'utf8'},
    );
    assert.equal(result.status, 0, name + ': ' + (result.stderr || result.stdout));
  }
});
