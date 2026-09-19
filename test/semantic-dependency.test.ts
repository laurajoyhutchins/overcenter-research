import assert from 'node:assert/strict';
import test from 'node:test';

import {
  semanticDependencySelection,
  type SemanticDependency,
} from '../src/semantic-dependency.ts';

const edge=(consumes:SemanticDependency['consumes']):SemanticDependency=>({
  kind:'semantic',
  upstream:'upstream',
  consumes,
});

test('semantic selector grammar recognizes the two admitted selectors',()=>{
  assert.equal(
    semanticDependencySelection(
      edge({kind:'output',selector:'verified-content'}),
    ),
    'verified-content',
  );
  assert.equal(
    semanticDependencySelection(
      edge({kind:'evidence',selector:'settlement-receipt'}),
    ),
    'settlement-receipt',
  );
});

test('semantic selector grammar rejects unsupported selectors with one stable code',()=>{
  assert.throws(
    ()=>semanticDependencySelection(
      edge({kind:'output',selector:'ambient-file'}),
    ),
    /UNSUPPORTED_SEMANTIC_SELECTOR:output:ambient-file/,
  );
  assert.throws(
    ()=>semanticDependencySelection(
      edge({kind:'evidence',selector:'worker-assertion'}),
    ),
    /UNSUPPORTED_SEMANTIC_SELECTOR:evidence:worker-assertion/,
  );
});
