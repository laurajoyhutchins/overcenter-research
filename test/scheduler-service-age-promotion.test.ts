import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRAPH_PATCH_SCHEMA,
  RECEIPT_SCHEMA,
  obligationDefinitionId,
  type FactCommit,
  type HistoricalRun,
  type ObligationDefinition,
  type Receipt,
  type State,
} from '../src/authority/facts.ts';
import { deriveProjectProjection } from '../src/authority/project-state.ts';
import { replayProjection } from '../src/authority/replay.ts';
import { obligationKey } from '../src/graph/identity.ts';
import type { Obligation } from '../src/model.ts';

function definition(path: string, content: string): ObligationDefinition {
  return {
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path,
      content,
    },
  };
}

function graphPatch(
  commit: string,
  parent: string | null,
  bindings: Array<{ node_id: string; definition: ObligationDefinition }>,
  retire: string[] = [],
  knownDefinitionIds = new Set<string>(),
): FactCommit {
  const definitions = bindings
    .map(({ definition: item }) => ({
      id: obligationDefinitionId(item),
      definition: item,
    }))
    .filter(({ id }) => !knownDefinitionIds.has(id));

  for (const { id } of definitions) knownDefinitionIds.add(id);

  return {
    commit,
    parent,
    graph_patch: {
      schema: GRAPH_PATCH_SCHEMA,
      definitions,
      bindings: bindings.map(({ node_id, definition: item }) => ({
        node_id,
        definition_id: obligationDefinitionId(item),
      })),
      retire,
    },
  };
}

test('replay derives current binding age and reconstructs it incrementally', () => {
  const known = new Set<string>();
  const a1 = definition('/provider/a', 'A1');
  const a2 = definition('/provider/a', 'A2');
  const b = definition('/provider/b', 'B');

  const commits: FactCommit[] = [
    { commit: 'c1', parent: null },
    graphPatch('c2', 'c1', [{ node_id: 'a', definition: a1 }], [], known),
    graphPatch('c3', 'c2', [{ node_id: 'b', definition: b }], [], known),
    graphPatch('c4', 'c3', [{ node_id: 'a', definition: a2 }], [], known),
    graphPatch('c5', 'c4', [], ['a'], known),
    graphPatch('c6', 'c5', [{ node_id: 'a', definition: a2 }], [], known),
  ];

  const full = replayProjection(commits);
  let incremental = replayProjection([commits[0]!]);
  for (const commit of commits.slice(1)) {
    incremental = replayProjection([commit], incremental);
  }

  assert.equal(full.history.authorityOrdinal, 6);
  assert.deepEqual(
    [...full.history.currentBindingOrdinals],
    [
      ['b', 3],
      ['a', 6],
    ],
  );
  assert.deepEqual(
    [...incremental.history.currentBindingOrdinals],
    [...full.history.currentBindingOrdinals],
  );
  assert.equal(full.project.readyWork?.id, 'b');
  assert.equal(incremental.project.readyWork?.id, 'b');
});

function work(id: string): Obligation {
  return {
    id,
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/' + id,
      content: id.toUpperCase(),
    },
  };
}

function readyReceipt(run: HistoricalRun, ordinal: number): Receipt {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: run.id,
    obligation_id: run.obligation_id,
    claimed_revision: run.claimed_revision,
    claim_commit: run.claim_commit,
    execution_generation: run.execution_generation,
    execution_authority_commit: run.execution_authority_commit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-23T00:00:00.000Z',
    disposition: 'READY',
    verified: false,
    settlement_commit: 'settle-' + ordinal,
  } as Receipt;
}

function historicalRun(
  state: State,
  obligation: Obligation,
  id: string,
  key: string,
  ordinal: number,
): HistoricalRun {
  return {
    id,
    obligation_id: obligation.id,
    claimed_revision: 'revision-' + ordinal,
    claim_commit: 'claim-' + ordinal,
    obligation_key: key,
    execution_generation: ordinal,
    execution_authority_commit: 'claim-' + ordinal,
    execution_capability_sha256: '0'.repeat(64),
    obligation,
    definition_id: state.definition_ids[obligation.id]!,
  };
}

test('service age uses binding age before first claim and claim age afterward', () => {
  const recovered = work('recovered');
  const fresh = work('fresh');
  const state: State = {
    obligations: { recovered, fresh },
    definition_ids: { recovered: 'define-recovered', fresh: 'define-fresh' },
  };

  const emptyReceipts = new Map<string, Receipt>();
  const empty = deriveProjectProjection({
    state,
    runs: new Map(),
    receiptsByRun: emptyReceipts,
    revision: 'initial',
  });
  const recoveredKey = obligationKey(state, recovered, empty.lifecycles, emptyReceipts);
  const freshKey = obligationKey(state, fresh, empty.lifecycles, emptyReceipts);
  assert.ok(recoveredKey);
  assert.ok(freshKey);

  const first = historicalRun(state, recovered, 'run-recovered-1', recoveredKey, 2);
  const runs = new Map([[first.id, first]]);
  const receipts = new Map([[first.id, readyReceipt(first, 2)]]);
  const bindingOrdinals = new Map([
    ['recovered', 1],
    ['fresh', 3],
  ]);
  const claimOrdinals = new Map([[first.id, 2]]);

  const beforeSecondClaim = deriveProjectProjection({
    state,
    runs,
    receiptsByRun: receipts,
    revision: 'before-second-claim',
    currentBindingOrdinals: bindingOrdinals,
    claimOrdinalsByRun: claimOrdinals,
  });
  assert.equal(beforeSecondClaim.readyWork?.id, 'recovered');

  const second = historicalRun(state, recovered, 'run-recovered-2', recoveredKey, 4);
  runs.set(second.id, second);
  receipts.set(second.id, readyReceipt(second, 4));
  claimOrdinals.set(second.id, 4);

  const afterSecondClaim = deriveProjectProjection({
    state,
    runs,
    receiptsByRun: receipts,
    revision: 'after-second-claim',
    currentBindingOrdinals: bindingOrdinals,
    claimOrdinalsByRun: claimOrdinals,
  });
  assert.equal(afterSecondClaim.readyWork?.id, 'fresh');
});

test('scheduler provenance fails closed when replay metadata is incomplete', () => {
  const only = work('only');
  const state: State = {
    obligations: { only },
    definition_ids: { only: 'define-only' },
  };

  assert.throws(
    () =>
      deriveProjectProjection({
        state,
        runs: new Map(),
        receiptsByRun: new Map(),
        revision: 'missing-binding-age',
        currentBindingOrdinals: new Map(),
        claimOrdinalsByRun: new Map(),
      }),
    /BINDING_ORDINAL_MISSING:only/,
  );
});
