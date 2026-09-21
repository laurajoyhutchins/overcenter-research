import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OvercenterKernel, runCoreLoop } from './kernel.ts';

const verify = (post, observed) => post.effect === observed.effect;

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-core-'));
  return { dir, path: join(dir, 'state.db') };
}

test('drives a dependency chain to DONE from authoritative observation', async () => {
  const k = new OvercenterKernel();
  k.define({ id: 'a', revision: 'r1', postcondition: { effect: 'a-present' }, packet: { effect: 'a-present' } });
  k.define({ id: 'b', revision: 'r1', deps: ['a'], postcondition: { effect: 'b-present' }, packet: { effect: 'b-present' } });
  const world = new Set();

  const result = await runCoreLoop(k, {
    execute: async packet => { world.add(packet.effect); return { kind: 'ok' }; },
    observe: async work => ({ effect: world.has(work.packet.effect) ? work.packet.effect : 'absent', mutation_certainty: 'present' }),
    verify,
  });

  assert.equal(result.state, 'IDLE');
  assert.deepEqual(k.inspect().map(x => [x.id, x.status]), [['a', 'DONE'], ['b', 'DONE']]);
  assert.equal(k.receipts().length, 2);
  k.close();
});

test('executor success alone cannot settle DONE', async () => {
  const k = new OvercenterKernel();
  k.define({ id: 'x', revision: 'r1', postcondition: { effect: 'present' } });

  const result = await runCoreLoop(k, {
    maxAdvances: 1,
    execute: async () => ({ kind: 'ok' }),
    observe: async () => ({ effect: 'absent', mutation_certainty: 'absent' }),
    verify,
  });

  assert.equal(result.state, 'BUDGET_EXHAUSTED');
  assert.equal(k.inspect()[0].status, 'READY');
  assert.equal(k.receipts()[0].disposition, 'READY');
  k.close();
});

test('uncertain external effect is not replayed', async () => {
  const k = new OvercenterKernel();
  k.define({ id: 'x', revision: 'r1', postcondition: { effect: 'present' } });
  let executions = 0;

  const first = await runCoreLoop(k, {
    execute: async () => { executions += 1; return { kind: 'timeout', may_have_mutated: true }; },
    observe: async () => ({ effect: 'unknown', mutation_certainty: 'uncertain' }),
    verify,
  });
  const second = await runCoreLoop(k, {
    execute: async () => { executions += 1; return { kind: 'ok' }; },
    observe: async () => ({ effect: 'present', mutation_certainty: 'present' }),
    verify,
  });

  assert.equal(first.state, 'RECOVERY_REQUIRED');
  assert.equal(second.state, 'IDLE');
  assert.equal(executions, 1);
  assert.equal(k.inspect()[0].status, 'RECOVERY_REQUIRED');
  k.close();
});

test('reconciliation can settle an uncertain effect without replay', async () => {
  const k = new OvercenterKernel();
  k.define({ id: 'x', revision: 'r1', postcondition: { effect: 'present' } });
  const run = k.claim('x', 'r1');
  k.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed: { effect: 'unknown', mutation_certainty: 'uncertain' } });

  const reconciled = k.reconcile(run.id, { effect: 'present', mutation_certainty: 'present' }, verify);

  assert.equal(reconciled.disposition, 'DONE');
  assert.equal(k.inspect()[0].status, 'DONE');
  assert.equal(k.receipts().length, 1);
  k.close();
});

test('claim is exact-revision fenced', () => {
  const k = new OvercenterKernel();
  k.define({ id: 'x', revision: 'r2', postcondition: { effect: 'present' } });
  assert.throws(() => k.claim('x', 'r1'), /STALE_REVISION/);
  assert.equal(k.inspect()[0].status, 'READY');
  k.close();
});

test('restart converts an interrupted claim into recovery instead of replay', () => {
  const { dir, path } = tempDb();
  try {
    const first = new OvercenterKernel(path);
    first.define({ id: 'x', revision: 'r1', postcondition: { effect: 'present' } });
    first.claim('x', 'r1');
    first.close();

    const restarted = new OvercenterKernel(path);
    assert.equal(restarted.recoverInterrupted(), 1);
    assert.equal(restarted.inspect()[0].status, 'RECOVERY_REQUIRED');
    assert.equal(restarted.deriveReadyWork(), null);
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settlement itself refuses unverified DONE', () => {
  const k = new OvercenterKernel();
  k.define({ id: 'x', revision: 'r1', postcondition: { effect: 'present' } });
  const run = k.claim('x', 'r1');
  assert.throws(() => k.settle(run.id, { disposition: 'DONE', observed: { effect: 'absent' } }), /UNVERIFIED_DONE/);
  assert.equal(k.inspect()[0].status, 'EXECUTING');
  k.close();
});
