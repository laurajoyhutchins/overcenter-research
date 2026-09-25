import assert from 'node:assert/strict';
import test from 'node:test';

import {
  obligationDefinition,
  obligationDefinitionId,
  type State,
} from '../src/authority/facts.ts';
import { deriveProjectProjection } from '../src/authority/project-state.ts';
import type { Obligation } from '../src/model.ts';

const obligation = (id: string, content: string): Obligation => ({
  id,
  dependencies: [],
  packet: { incidental: { z: 2, a: 1 } },
  postcondition: {
    verifier: 'file-content-equals/v1',
    path: `/provider/${id}`,
    content,
  },
});

function projectionSignature(state: State) {
  const project = deriveProjectProjection({
    state,
    runs: new Map(),
    receiptsByRun: new Map(),
    revision: 'revision-a',
  });
  return {
    work: project.work.map(({ id, status, blocked_reason }) => ({
      id,
      status,
      blocked_reason: blocked_reason ?? null,
    })),
    ready: project.readyWork?.id ?? null,
    semantic_keys: [...project.semanticKeys.entries()].sort(([a], [b]) => a.localeCompare(b)),
    explanations: [...project.explanations.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

test('project truth is invariant to obligation record insertion order', () => {
  const a = obligation('a', 'A');
  const b = obligation('b', 'B');
  const left: State = {
    obligations: { a, b },
    definition_ids: { a: 'definition-a', b: 'definition-b' },
  };
  const right: State = {
    obligations: { b, a },
    definition_ids: { b: 'definition-b', a: 'definition-a' },
  };

  assert.deepEqual(projectionSignature(left), projectionSignature(right));
});

test('obligation identity ignores dependency representation order', () => {
  const base: Obligation = {
    id: 'consumer',
    dependencies: [
      { kind: 'control', upstream: 'prepare' },
      {
        kind: 'semantic',
        upstream: 'source',
        consumes: { kind: 'evidence', selector: 'receipt' },
      },
    ],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/consumer',
      content: 'done',
    },
  };
  const reordered: Obligation = {
    ...base,
    dependencies: [...base.dependencies].reverse(),
  };

  assert.equal(
    obligationDefinitionId(obligationDefinition(base)),
    obligationDefinitionId(obligationDefinition(reordered)),
  );
});

test('scientifically meaningful postcondition drift changes obligation identity', () => {
  const before = obligation('a', 'A');
  const after = obligation('a', 'B');

  assert.notEqual(
    obligationDefinitionId(obligationDefinition(before)),
    obligationDefinitionId(obligationDefinition(after)),
  );
});

test('semantic dependency drift changes obligation identity', () => {
  const control: Obligation = {
    id: 'consumer',
    dependencies: [{ kind: 'control', upstream: 'source' }],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/consumer',
      content: 'done',
    },
  };
  const semantic: Obligation = {
    ...control,
    dependencies: [
      {
        kind: 'semantic',
        upstream: 'source',
        consumes: { kind: 'evidence', selector: 'receipt' },
      },
    ],
  };

  assert.notEqual(
    obligationDefinitionId(obligationDefinition(control)),
    obligationDefinitionId(obligationDefinition(semantic)),
  );
});
