import assert from 'node:assert/strict';
import test from 'node:test';

import type { State } from '../src/authority/facts.ts';
import {
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
} from '../src/authority/facts.ts';
import { planGraphReconciliation } from '../src/graph/reconciliation.ts';

const pc = (path: string, content: string) => ({
  verifier: 'file-content-equals/v1' as const,
  path,
  content,
});

test('graph reconciliation deterministically classifies add rebind and unchanged', () => {
  const unchanged = normalizeObligation({
    id: 'unchanged',
    dependencies: [
      { kind: 'control', upstream: 'root' },
      { kind: 'control', upstream: 'other' },
    ],
    packet: { value: 1 },
    postcondition: pc('/tmp/unchanged', 'A'),
  });
  const changed = normalizeObligation({
    id: 'changed',
    packet: { value: 1 },
    postcondition: pc('/tmp/changed', 'A'),
  });
  const state: State = {
    obligations: { unchanged, changed },
    definition_ids: {
      unchanged: obligationDefinitionId(obligationDefinition(unchanged)),
      changed: obligationDefinitionId(obligationDefinition(changed)),
    },
  };

  const plan = planGraphReconciliation(state, [
    {
      id: 'new',
      postcondition: pc('/tmp/new', 'N'),
    },
    {
      id: 'changed',
      packet: { value: 2 },
      postcondition: pc('/tmp/changed', 'A'),
    },
    {
      id: 'unchanged',
      dependencies: [
        { kind: 'control', upstream: 'other' },
        { kind: 'control', upstream: 'root' },
      ],
      packet: { value: 1 },
      postcondition: pc('/tmp/unchanged', 'A'),
    },
  ]);

  assert.deepEqual(
    plan.upsert.map(({ id }) => id),
    ['changed', 'new'],
  );
  assert.deepEqual(plan.added, ['new']);
  assert.deepEqual(plan.rebound, ['changed']);
  assert.deepEqual(plan.unchanged, ['unchanged']);
});

test('graph reconciliation rejects duplicate desired identities', () => {
  const state: State = { obligations: {}, definition_ids: {} };
  assert.throws(
    () =>
      planGraphReconciliation(state, [
        { id: 'a', postcondition: pc('/tmp/a', 'A') },
        { id: 'a', postcondition: pc('/tmp/a', 'A') },
      ]),
    /DUPLICATE_DESIRED_OBLIGATION:a/,
  );
});

test('managed reconciliation retires only missing obligations in its namespace', () => {
  const managed = normalizeObligation({
    id: 'tcb:stale',
    postcondition: {
      verifier: 'operator-judgment/v1',
      subject: { kind: 'tcb-remediation' },
    },
  });
  const ordinary = normalizeObligation({
    id: 'ordinary',
    postcondition: pc('/tmp/ordinary', 'A'),
  });
  const state: State = {
    obligations: { [managed.id]: managed, [ordinary.id]: ordinary },
    definition_ids: {
      [managed.id]: obligationDefinitionId(obligationDefinition(managed)),
      [ordinary.id]: obligationDefinitionId(obligationDefinition(ordinary)),
    },
  };

  const plan = planGraphReconciliation(
    state,
    [{ id: 'ordinary', postcondition: pc('/tmp/ordinary', 'A') }],
    ['tcb:'],
  );

  assert.deepEqual(plan.retire, ['tcb:stale']);
  assert.deepEqual(plan.unchanged, ['ordinary']);
  assert.deepEqual(plan.upsert, []);
});
