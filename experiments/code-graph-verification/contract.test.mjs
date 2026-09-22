import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root = new URL('.', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', root), 'utf8'));

test('corpus has exact human and AI variants for every admitted case', () => {
  assert.equal(corpus.schema, 'overcenter-code-graph-verification-corpus/v1');
  assert.ok(corpus.cases.length >= 2);

  for (const c of corpus.cases) {
    assert.match(c.base_commit, /^[0-9a-f]{40}$/);
    const kinds = new Set(c.variants.map(v => v.authorship));
    assert.ok(kinds.has('human'), c.id + ' lacks a human variant');
    assert.ok(kinds.has('ai'), c.id + ' lacks an AI variant');

    for (const v of c.variants) {
      assert.equal(v.primary, true);
      assert.ok(v.patch);
      assert.ok(v.provenance?.source);
    }
  }
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

test('unreproducible AI outcomes stay outside the primary corpus', () => {
  assert.ok(corpus.documented_ai_cases.length >= 1);
  for (const c of corpus.documented_ai_cases) {
    assert.equal(c.primary, false);
    assert.equal(c.exclusion_reason, 'exact_patch_artifact_not_pinned');
  }
});
