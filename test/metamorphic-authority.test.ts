import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../src/authority/facts.ts';
import { deriveProjectProjection } from '../src/authority/project-state.ts';
import { obligationKey } from '../src/graph/identity.ts';
import type { Obligation } from '../src/model.ts';
import { githubCommitStatus } from '../src/providers/github/status-resource.ts';

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


test('production GitHub effect coordinate is representation-stable and drift fails closed', () => {
  const base = normalizeObligation(
    githubCommitStatus.ensure({
      id: 'status-proof',
      target: {
        repository_id: 42,
        repository_full_name: 'acme/widget',
        commit_sha: 'a'.repeat(40),
        context: 'overcenter/proof',
      },
      desired: { state: 'success' },
    }),
  );
  const reordered = normalizeObligation(
    githubCommitStatus.ensure({
      id: 'status-proof',
      target: {
        context: 'overcenter/proof',
        commit_sha: 'a'.repeat(40),
        repository_full_name: 'acme/widget',
        repository_id: 42,
      },
      desired: { state: 'success' },
    }),
  );
  const changedCoordinate = normalizeObligation(
    githubCommitStatus.ensure({
      id: 'status-proof',
      target: {
        repository_id: 42,
        repository_full_name: 'acme/widget',
        commit_sha: 'a'.repeat(40),
        context: 'overcenter/other-proof',
      },
      desired: { state: 'success' },
    }),
  );

  const definitionId = (work: Obligation) =>
    obligationDefinitionId(obligationDefinition(work));
  const stateFor = (work: Obligation): State => ({
    obligations: { [work.id]: work },
    definition_ids: { [work.id]: definitionId(work) },
  });
  const keyFor = (work: Obligation) =>
    obligationKey(stateFor(work), work, new Map(), new Map());

  const baseDefinitionId = definitionId(base);
  const baseKey = keyFor(base);
  assert.ok(baseKey);

  assert.equal(definitionId(reordered), baseDefinitionId);
  assert.equal(keyFor(reordered), baseKey);
  assert.notEqual(definitionId(changedCoordinate), baseDefinitionId);
  assert.notEqual(keyFor(changedCoordinate), baseKey);

  const run: HistoricalRun = {
    id: 'run-status-proof',
    obligation_id: base.id,
    claimed_revision: 'revision-a',
    claim_commit: 'claim-a',
    obligation_key: baseKey,
    execution_generation: 1,
    execution_authority_commit: 'authority-a',
    execution_capability_sha256: 'a'.repeat(64),
    obligation: base,
    definition_id: baseDefinitionId,
  };
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: run.id,
    obligation_id: run.obligation_id,
    claimed_revision: run.claimed_revision,
    claim_commit: run.claim_commit,
    execution_generation: run.execution_generation,
    execution_authority_commit: run.execution_authority_commit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-25T00:00:00.000Z',
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'settlement-a',
  };
  const statusFor = (work: Obligation) =>
    deriveProjectProjection({
      state: stateFor(work),
      runs: new Map([[run.id, run]]),
      receiptsByRun: new Map([[run.id, receipt]]),
      revision: 'revision-a',
    }).work[0]?.status;

  assert.equal(statusFor(reordered), 'DONE');
  assert.equal(statusFor(changedCoordinate), 'READY');
});
