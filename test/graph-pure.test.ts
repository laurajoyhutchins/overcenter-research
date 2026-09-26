import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { HistoricalRun, State } from '../src/authority/facts.ts';
import { delegationCreatesCausalCycle } from '../src/authority/delegation.ts';
import {
  buildGraphIndex,
  dependencyUpstreams,
  dependsOn,
  graphDependsOn,
  validateGraph,
  withObligation,
} from '../src/graph/topology.ts';

const obligation = (id: string, dependencies: Obligation['dependencies'] = []): Obligation => ({
  id,
  dependencies,
  packet: {},
  postcondition: {
    verifier: 'file-content-equals/v1',
    path: `/tmp/${id}`,
    content: id,
  },
});

test('static graph validation accepts an acyclic dependency chain', () => {
  let state: State = { obligations: {}, definition_ids: {} };
  state = withObligation(state, obligation('a'), 'a-def');
  state = withObligation(state, obligation('b', [{ kind: 'control', upstream: 'a' }]), 'b-def');
  state = withObligation(
    state,
    obligation('c', [
      {
        kind: 'semantic',
        upstream: 'b',
        consumes: { kind: 'output', selector: 'verified-content' },
      },
    ]),
    'c-def',
  );

  validateGraph(state);
  assert.deepEqual(dependencyUpstreams(state.obligations.c), ['b']);
  assert.equal(dependsOn(state, 'c', 'a'), true);
  assert.equal(dependsOn(state, 'a', 'c'), false);
});

test('static graph validation rejects unknown dependencies and cycles', () => {
  const unknown: State = {
    obligations: {
      a: obligation('a', [{ kind: 'control', upstream: 'missing' }]),
    },
    definition_ids: { a: 'a-def' },
  };
  assert.throws(() => validateGraph(unknown), /UNKNOWN_DEPENDENCY:a:missing/);

  const cycle: State = {
    obligations: {
      a: obligation('a', [{ kind: 'control', upstream: 'b' }]),
      b: obligation('b', [{ kind: 'control', upstream: 'a' }]),
    },
    definition_ids: { a: 'a-def', b: 'b-def' },
  };
  assert.throws(() => validateGraph(cycle), /DEPENDENCY_CYCLE/);
});

test('graph index handles a 10,000-node dependency chain without recursion', () => {
  const count = 10_000;
  const obligations: State['obligations'] = {};
  const definition_ids: State['definition_ids'] = {};
  for (let index = 0; index < count; index += 1) {
    const id = 'deep-' + String(index).padStart(5, '0');
    obligations[id] = obligation(
      id,
      index === 0
        ? []
        : [
            {
              kind: 'control',
              upstream: 'deep-' + String(index - 1).padStart(5, '0'),
            },
          ],
    );
    definition_ids[id] = id + '-def';
  }

  const graph = buildGraphIndex({ obligations, definition_ids });
  assert.equal(graph.topologicalOrder.length, count);
  assert.equal(graph.topologicalOrder[0], 'deep-00000');
  assert.equal(graph.topologicalOrder.at(-1), 'deep-09999');
  assert.equal(graphDependsOn(graph, 'deep-09999', 'deep-00000'), true);
});

const historicalRun = (id: string, work: Obligation): HistoricalRun => ({
  id,
  obligation_id: work.id,
  claimed_revision: 'revision',
  claim_commit: 'claim',
  obligation_key: 'obligation-key',
  execution_generation: 1,
  execution_authority_commit: 'authority',
  execution_capability_sha256: '0'.repeat(64),
  obligation: work,
  definition_id: work.id + '-def',
});

test('delegation cycle detection fails closed when an outstanding parent run is missing', () => {
  const parent = obligation('parent');
  const child = obligation('child');
  const state: State = {
    obligations: { parent, child },
    definition_ids: { parent: 'parent-def', child: 'child-def' },
  };
  const unresolved = new Map([
    ['missing-run', new Map([['delegation-1', { child_obligation_id: 'child' }]])],
  ]);

  assert.throws(
    () =>
      delegationCreatesCausalCycle({
        state,
        runs: new Map(),
        unresolvedDelegationsByRun: unresolved,
        parentObligationId: 'parent',
        childObligationId: 'child',
      }),
    /DELEGATION_PARENT_RUN_MISSING/,
  );
});

test('delegation cycle detection rejects a transitive dependency cycle', () => {
  const parent = obligation('parent');
  const middle = obligation('middle', [{ kind: 'control', upstream: 'parent' }]);
  const child = obligation('child', [{ kind: 'control', upstream: 'middle' }]);
  const state: State = {
    obligations: { parent, middle, child },
    definition_ids: {
      parent: 'parent-def',
      middle: 'middle-def',
      child: 'child-def',
    },
  };

  assert.equal(
    delegationCreatesCausalCycle({
      state,
      runs: new Map(),
      unresolvedDelegationsByRun: new Map(),
      parentObligationId: 'parent',
      childObligationId: 'child',
    }),
    true,
  );
});

test('delegation cycle detection rejects a delegated-child cycle', () => {
  const parent = obligation('parent');
  const child = obligation('child');
  const state: State = {
    obligations: { parent, child },
    definition_ids: { parent: 'parent-def', child: 'child-def' },
  };
  const childRun = historicalRun('child-run', child);
  const unresolved = new Map([
    [childRun.id, new Map([['delegation-1', { child_obligation_id: 'parent' }]])],
  ]);

  assert.equal(
    delegationCreatesCausalCycle({
      state,
      runs: new Map([[childRun.id, childRun]]),
      unresolvedDelegationsByRun: unresolved,
      parentObligationId: 'parent',
      childObligationId: 'child',
    }),
    true,
  );
});

test('delegation cycle detection traverses mixed acyclic waits without a false positive', () => {
  const parent = obligation('parent');
  const upstream = obligation('upstream');
  const child = obligation('child', [{ kind: 'control', upstream: 'upstream' }]);
  const leaf = obligation('leaf');
  const state: State = {
    obligations: { parent, upstream, child, leaf },
    definition_ids: {
      parent: 'parent-def',
      upstream: 'upstream-def',
      child: 'child-def',
      leaf: 'leaf-def',
    },
  };
  const childRun = historicalRun('child-run', child);
  const unresolved = new Map([
    [childRun.id, new Map([['delegation-1', { child_obligation_id: 'leaf' }]])],
  ]);

  assert.equal(
    delegationCreatesCausalCycle({
      state,
      runs: new Map([[childRun.id, childRun]]),
      unresolvedDelegationsByRun: unresolved,
      parentObligationId: 'parent',
      childObligationId: 'child',
    }),
    false,
  );
});
