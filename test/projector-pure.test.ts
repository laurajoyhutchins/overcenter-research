import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import { RECEIPT_SCHEMA } from '../src/authority/facts.ts';
import type { HistoricalRun, Receipt, State } from '../src/authority/facts.ts';
import { obligationKey } from '../src/graph/identity.ts';
import { deriveProjectProjection } from '../src/authority/project-state.ts';

const work: Obligation = {
  id: 'a',
  dependencies: [],
  packet: {},
  postcondition: { verifier: 'file-content-equals/v1', path: '/provider/a', content: 'A' },
};
const state: State = { obligations: { a: work }, definition_ids: { a: 'define-a' } };

test('unrealized lifecycle becomes public READY only through project projection', () => {
  const project = deriveProjectProjection({
    state,
    runs: new Map(),
    receiptsByRun: new Map(),
    revision: 'revision-a',
  });
  assert.equal(project.lifecycles.get('a')?.status, 'UNREALIZED');
  assert.equal(project.claimabilityErrors.get('a'), null);
  assert.equal(project.work.find((candidate) => candidate.id === 'a')?.status, 'READY');
  assert.equal(project.readyWork?.id, 'a');
});

test('a valid historical realization remains DONE, not READY', () => {
  const receipts = new Map<string, Receipt>();
  const base = deriveProjectProjection({
    state,
    runs: new Map<string, HistoricalRun>(),
    receiptsByRun: receipts,
    revision: 'revision-a',
  });
  const key = obligationKey(state, work, base.lifecycles, receipts);
  assert.ok(key);
  const run: HistoricalRun = {
    id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    obligation_key: key,
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    execution_capability_sha256: '0'.repeat(64),
    obligation: work,
    definition_id: 'define-a',
  };
  const receipt: Receipt = {
    schema: 'overcenter-git-receipt-v5',
    run_id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    kind: 'observation',
    observed: {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty: 'present',
    },
    settled_at: '2026-09-18T00:00:00.000Z',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'receipt-a',
  };
  const project = deriveProjectProjection({
    state,
    runs: new Map([['run-a', run]]),
    receiptsByRun: new Map([['run-a', receipt]]),
    revision: 'revision-b',
  });
  assert.equal(project.lifecycles.get('a')?.status, 'DONE');
  assert.equal(project.work.find((candidate) => candidate.id === 'a')?.status, 'DONE');
  assert.equal(project.readyWork, null);
});

test('current realization admissibility can withdraw historical DONE', () => {
  const receipts = new Map<string, Receipt>();
  const base = deriveProjectProjection({
    state,
    runs: new Map<string, HistoricalRun>(),
    receiptsByRun: receipts,
    revision: 'revision-a',
  });
  const key = obligationKey(state, work, base.lifecycles, receipts);
  assert.ok(key);

  const run: HistoricalRun = {
    id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    obligation_key: key,
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    execution_capability_sha256: '0'.repeat(64),
    obligation: work,
    definition_id: 'define-a',
  };
  const receipt: Receipt = {
    schema: 'overcenter-git-receipt-v5',
    run_id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    kind: 'observation',
    observed: {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty: 'present',
    },
    settled_at: '2026-09-18T00:00:00.000Z',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'receipt-a',
  };

  const project = deriveProjectProjection({
    state,
    runs: new Map([['run-a', run]]),
    receiptsByRun: new Map([['run-a', receipt]]),
    revision: 'revision-b',
    currentRealizationJudgments: new Map([
      [
        'run-a',
        {
          state: 'rejected' as const,
          reason: 'CURRENT_POSTCONDITION_NOT_VERIFIED' as const,
        },
      ],
    ]),
  });

  assert.equal(project.lifecycles.get('a')?.status, 'UNREALIZED');
  assert.equal(project.work.find((candidate) => candidate.id === 'a')?.status, 'READY');
  assert.equal(project.readyWork?.id, 'a');
});

test('indeterminate current realization judgment blocks replay instead of becoming READY', () => {
  const receipts = new Map<string, Receipt>();
  const base = deriveProjectProjection({
    state,
    runs: new Map<string, HistoricalRun>(),
    receiptsByRun: receipts,
    revision: 'revision-a',
  });
  const key = obligationKey(state, work, base.lifecycles, receipts);
  assert.ok(key);
  const run: HistoricalRun = {
    id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    obligation_key: key,
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    execution_capability_sha256: '0'.repeat(64),
    obligation: work,
    definition_id: 'define-a',
  };
  const receipt: Receipt = {
    schema: 'overcenter-git-receipt-v5',
    run_id: 'run-a',
    obligation_id: 'a',
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    execution_generation: 1,
    execution_authority_commit: 'claim-a',
    kind: 'observation',
    observed: {
      verifier: 'file-content-equals/v1',
      path: '/provider/a',
      expected_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      actual_sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
      mutation_certainty: 'present',
    },
    settled_at: '2026-09-18T00:00:00.000Z',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'receipt-a',
  };
  const project = deriveProjectProjection({
    state,
    runs: new Map([['run-a', run]]),
    receiptsByRun: new Map([['run-a', receipt]]),
    revision: 'revision-b',
    currentRealizationJudgments: new Map([
      [
        'run-a',
        {
          state: 'indeterminate',
          reason: 'CURRENT_REALIZATION_OBSERVATION_INDETERMINATE',
        },
      ],
    ]),
  });

  assert.equal(project.lifecycles.get('a')?.status, 'UNREALIZED');
  assert.equal(
    project.claimabilityErrors.get('a'),
    'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE',
  );
  assert.equal(project.work.find((candidate) => candidate.id === 'a')?.status, 'BLOCKED');
  assert.equal(project.readyWork, null);
});

test('READY selection is starvation-free in bounded replayable schedules', () => {
  const make = (id: string): Obligation => ({
    id,
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: `/provider/${id}`,
      content: id.toUpperCase(),
    },
  });

  for (let count = 1; count <= 5; count += 1) {
    const ids = Array.from({ length: count }, (_, index) =>
      String.fromCharCode('a'.charCodeAt(0) + index),
    );
    const obligations: Record<string, Obligation> = Object.fromEntries(
      ids.map((id) => [id, make(id)]),
    );
    const fairState: State = {
      obligations,
      definition_ids: Object.fromEntries(ids.map((id) => [id, `define-${id}`])),
    };
    const emptyReceipts = new Map<string, Receipt>();
    const base = deriveProjectProjection({
      state: fairState,
      runs: new Map(),
      receiptsByRun: emptyReceipts,
      revision: 'define-all',
    });
    const semanticKeys = new Map(
      ids.map((id) => {
        const key = obligationKey(fairState, obligations[id]!, base.lifecycles, emptyReceipts);
        assert.ok(key);
        return [id, key] as const;
      }),
    );
    const runs = new Map<string, HistoricalRun>();
    const receipts = new Map<string, Receipt>();
    const seen: string[] = [];

    for (let step = 0; step < count * 2; step += 1) {
      const revision = `revision-${step}`;
      const projection = deriveProjectProjection({
        state: fairState,
        runs,
        receiptsByRun: receipts,
        revision,
      });
      const id = projection.readyWork?.id;
      assert.ok(id);
      seen.push(id);

      const runId = `run-${step}-${id}`;
      const claimCommit = `claim-${step}-${id}`;
      const run: HistoricalRun = {
        id: runId,
        obligation_id: id,
        claimed_revision: revision,
        claim_commit: claimCommit,
        obligation_key: semanticKeys.get(id)!,
        execution_generation: step + 1,
        execution_authority_commit: claimCommit,
        execution_capability_sha256: '0'.repeat(64),
        obligation: obligations[id]!,
        definition_id: `define-${id}`,
      };
      runs.set(runId, run);
      receipts.set(runId, {
        schema: RECEIPT_SCHEMA,
        run_id: runId,
        obligation_id: id,
        claimed_revision: revision,
        claim_commit: claimCommit,
        execution_generation: step + 1,
        execution_authority_commit: claimCommit,
        kind: 'observation',
        observed: null,
        settled_at: '2026-09-23T00:00:00.000Z',
        disposition: 'READY',
        verified: false,
      } as Receipt);
    }

    assert.deepEqual(seen, [...ids, ...ids]);
  }
});
