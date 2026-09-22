import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root = new URL('.', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', root), 'utf8'));

function patch(relative) {
  const text = readFileSync(new URL(relative, root), 'utf8');
  assert.ok(text.startsWith('diff --git '), relative);
  return text;
}

test('Pylint holdout selection is frozen and outcome blind', () => {
  assert.equal(corpus.schema, 'overcenter-code-graph-holdout-corpus/v1');
  assert.equal(corpus.subject.repository, 'pylint-dev/pylint');
  assert.equal(corpus.cases.length, 8);
  assert.deepEqual(corpus.cases.map(c => c.id), [
    'pylint-dev__pylint-4551',
    'pylint-dev__pylint-4604',
    'pylint-dev__pylint-4661',
    'pylint-dev__pylint-4970',
    'pylint-dev__pylint-6386',
    'pylint-dev__pylint-6528',
    'pylint-dev__pylint-6903',
    'pylint-dev__pylint-7080',
  ]);
  assert.equal(corpus.primary_thresholds.recall_min, 0.99);
  assert.equal(corpus.primary_thresholds.selected_fraction_max, 0.30);
  assert.equal(corpus.primary_thresholds.missed_regressions_max, 0);
  assert.equal(corpus.representation.frozen_before_holdout_outcomes, true);
  assert.equal(corpus.representation.bounded_attribute_candidate_limit, 3);
  assert.equal(corpus.contamination.requests_holdout_excluded, true);

  let human = 0;
  let ai = 0;
  for (const c of corpus.cases) {
    assert.match(c.base_commit, /^[0-9a-f]{40}$/);
    assert.equal(c.variants.length, 2);
    const humanBytes = patch(c.variants[0].patch);
    const aiBytes = patch(c.variants[1].patch);
    assert.notEqual(
      createHash('sha256').update(humanBytes).digest('hex'),
      createHash('sha256').update(aiBytes).digest('hex'),
      c.id,
    );

    for (const v of c.variants) {
      assert.equal('evaluation' in v, false);
      const bytes = patch(v.patch);
      const touched = [...bytes.matchAll(/^\+\+\+ b\/(.+)$/gm)]
        .map(match => match[1]);
      assert.ok(
        touched.every(path =>
          path !== 'tests'
          && !path.startsWith('tests/')
          && !path.startsWith('test_')
          && !path.includes('/tests/')
        ),
        c.id + '/' + v.id + ' modifies tests',
      );
      if (v.authorship === 'human') human++;
      if (v.authorship === 'ai') {
        ai++;
        assert.equal(v.id, 'ai-agentless-0');
        assert.match(v.provenance.path, /dedup_patch_0\.jsonl$/);
        assert.match(
          v.provenance.selection_rule,
          /no outcome metadata consulted/,
        );
      }
    }
  }
  assert.equal(human, 8);
  assert.equal(ai, 8);
});

test('graph and scorer identities are hard pinned', () => {
  for (const [path, expected] of [
    [
      corpus.representation.frontier_path,
      corpus.representation.frontier_git_blob_sha,
    ],
    [
      corpus.representation.score_path,
      corpus.representation.score_git_blob_sha,
    ],
  ]) {
    const result = spawnSync('git', ['hash-object', path], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, path);
  }
});

test('holdout lifecycle scripts parse without side effects', () => {
  for (const name of ['preflight.py', 'run_case.py', 'summarize.py']) {
    const result = spawnSync(
      'python3',
      [new URL(name, root).pathname, '--help'],
      {encoding: 'utf8'},
    );
    assert.equal(
      result.status,
      0,
      name + ': ' + (result.stderr || result.stdout),
    );
  }
});
