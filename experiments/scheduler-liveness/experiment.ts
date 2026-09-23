import assert from 'node:assert/strict';

import { RECEIPT_SCHEMA } from '../../src/authority/facts.ts';
import type { HistoricalRun, Receipt, State } from '../../src/authority/facts.ts';
import { deriveProjectProjection } from '../../src/authority/project-state.ts';
import { obligationKey } from '../../src/graph/identity.ts';
import type { Obligation } from '../../src/model.ts';

const CONCURRENCY = [1, 2, 4] as const;
const FIXED_FRESH = 8;
const HOSTILE_WAVES = 16;
const BROKEN_STEPS = 64;

interface Harness {
  state: State;
  runs: Map<string, HistoricalRun>;
  receipts: Map<string, Receipt>;
  sequence: number;
}

function makeObligation(id: string): Obligation {
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

function makeHarness(): Harness {
  return {
    state: { obligations: {}, definition_ids: {} },
    runs: new Map(),
    receipts: new Map(),
    sequence: 0,
  };
}

function addObligation(harness: Harness, id: string): void {
  harness.state.obligations[id] = makeObligation(id);
  harness.state.definition_ids[id] = 'define-' + id;
}

function project(harness: Harness, label: string) {
  return deriveProjectProjection({
    state: harness.state,
    runs: harness.runs,
    receiptsByRun: harness.receipts,
    revision: label,
  });
}

function recordReadyClaim(harness: Harness, id: string, label: string): void {
  const before = project(harness, label + '-before');
  const obligation = harness.state.obligations[id];
  assert.ok(obligation);
  const key = obligationKey(harness.state, obligation, before.lifecycles, harness.receipts);
  assert.ok(key);

  harness.sequence += 1;
  const runId = 'run-' + harness.sequence + '-' + id;
  const claimCommit = 'claim-' + harness.sequence + '-' + id;
  const run: HistoricalRun = {
    id: runId,
    obligation_id: id,
    claimed_revision: label,
    claim_commit: claimCommit,
    obligation_key: key,
    execution_generation: harness.sequence,
    execution_authority_commit: claimCommit,
    execution_capability_sha256: '0'.repeat(64),
    obligation,
    definition_id: 'define-' + id,
  };
  harness.runs.set(runId, run);
  harness.receipts.set(runId, {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    obligation_id: id,
    claimed_revision: label,
    claim_commit: claimCommit,
    execution_generation: harness.sequence,
    execution_authority_commit: claimCommit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-23T00:00:00.000Z',
    disposition: 'READY',
    verified: false,
  } as Receipt);
}

function seedRecoveredTarget(harness: Harness): void {
  addObligation(harness, 'recovered-target');
  recordReadyClaim(harness, 'recovered-target', 'seed-recovery');
  assert.equal(
    project(harness, 'seed-check').work.find((work) => work.id === 'recovered-target')?.status,
    'READY',
  );
}

function runStableFiniteCase(concurrency: number) {
  const harness = makeHarness();
  seedRecoveredTarget(harness);
  for (let index = 0; index < FIXED_FRESH; index += 1) {
    addObligation(harness, 'fresh-' + String(index).padStart(2, '0'));
  }

  let selections = 0;
  let waves = 0;
  let targetSelection: number | null = null;

  while (targetSelection === null && selections < 64) {
    waves += 1;
    for (let slot = 0; slot < concurrency && targetSelection === null; slot += 1) {
      const projection = project(harness, 'stable-' + concurrency + '-' + selections);
      const selected = projection.readyWork?.id;
      assert.ok(selected);
      selections += 1;
      if (selected === 'recovered-target') targetSelection = selections;
      recordReadyClaim(harness, selected, 'stable-claim-' + concurrency + '-' + selections);
    }
  }

  assert.notEqual(targetSelection, null);
  assert.ok(targetSelection! <= FIXED_FRESH + 1);
  return { concurrency, selections, waves, target_selection: targetSelection };
}

function runBrokenPriorityCase() {
  const harness = makeHarness();
  addObligation(harness, 'hot-a');
  seedRecoveredTarget(harness);

  const selected: string[] = [];
  for (let step = 0; step < BROKEN_STEPS; step += 1) {
    const projection = project(harness, 'broken-' + step);
    const candidate = [...projection.work]
      .filter((work) => work.status === 'READY')
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    assert.ok(candidate);
    selected.push(candidate.id);
    recordReadyClaim(harness, candidate.id, 'broken-claim-' + step);
  }

  assert.ok(selected.every((id) => id === 'hot-a'));
  assert.ok(!selected.includes('recovered-target'));
  return { steps: BROKEN_STEPS, selected_unique: [...new Set(selected)] };
}

function runFreshFloodCase(concurrency: number) {
  const harness = makeHarness();
  seedRecoveredTarget(harness);
  const selected: string[] = [];
  let freshOrdinal = 0;

  for (let wave = 0; wave < HOSTILE_WAVES; wave += 1) {
    for (let slot = 0; slot < concurrency; slot += 1) {
      const id = 'arrival-' + String(freshOrdinal).padStart(4, '0');
      freshOrdinal += 1;
      addObligation(harness, id);
    }

    for (let slot = 0; slot < concurrency; slot += 1) {
      const projection = project(harness, 'flood-' + concurrency + '-' + wave + '-' + slot);
      const id = projection.readyWork?.id;
      assert.ok(id);
      selected.push(id);
      assert.notEqual(id, 'recovered-target');
      recordReadyClaim(harness, id, 'flood-claim-' + concurrency + '-' + wave + '-' + slot);
    }
  }

  assert.equal(selected.length, HOSTILE_WAVES * concurrency);
  assert.ok(!selected.includes('recovered-target'));
  return {
    concurrency,
    waves: HOSTILE_WAVES,
    selections: selected.length,
    admitted_fresh: freshOrdinal,
    target_selected: false,
  };
}

const stable = CONCURRENCY.map(runStableFiniteCase);
const broken = runBrokenPriorityCase();
const freshFlood = CONCURRENCY.map(runFreshFloodCase);

for (const result of stable) {
  console.log(JSON.stringify({ kind: 'scheduler-liveness-stable', ...result }));
}
console.log(JSON.stringify({ kind: 'scheduler-liveness-broken-priority', ...broken }));
for (const result of freshFlood) {
  console.log(JSON.stringify({ kind: 'scheduler-liveness-fresh-flood', ...result }));
}

console.log(
  JSON.stringify({
    kind: 'scheduler-liveness-summary',
    stable_fixed_set_progress: true,
    broken_priority_starvation_witness: true,
    continual_fresh_arrival_starvation_witness: true,
  }),
);
