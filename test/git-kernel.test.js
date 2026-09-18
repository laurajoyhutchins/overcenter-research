import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel, runGitCoreLoop } from '../src/git-kernel.js';

const verify = (post, observed) => post.effect === observed.effect;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-git-'));
  execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(dir);
  kernel.initialize();
  return { dir, kernel };
}

function parent(dir, commit) {
  return execFileSync('git', ['-C', dir, 'rev-parse', `${commit}^`], { encoding: 'utf8' }).trim();
}

test('Git commit SHA is the authoritative revision and claim is a child commit', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    assert.equal(work.revision, kernel.head());
    const run = kernel.claim('x', work.revision);
    assert.equal(run.claimed_revision, work.revision);
    assert.equal(parent(dir, run.claim_commit), work.revision);
    assert.equal(kernel.head(), run.claim_commit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two readers of one revision cannot both claim it', () => {
  const { dir, kernel: first } = repo();
  try {
    first.define({ id: 'x', postcondition: { effect: 'present' } });
    const second = new GitOvercenterKernel(dir);
    const a = first.deriveReadyWork();
    const b = second.deriveReadyWork();
    assert.equal(a.revision, b.revision);
    first.claim('x', a.revision);
    assert.throws(() => second.claim('x', b.revision), /STALE_REVISION/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('drives a dependency chain to DONE with immutable receipt commits', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'a', postcondition: { effect: 'a-present' }, packet: { effect: 'a-present' } });
    kernel.define({ id: 'b', deps: ['a'], postcondition: { effect: 'b-present' }, packet: { effect: 'b-present' } });
    const world = new Set();
    const result = await runGitCoreLoop(kernel, {
      execute: async packet => { world.add(packet.effect); return { kind: 'ok' }; },
      observe: async work => ({ effect: world.has(work.packet.effect) ? work.packet.effect : 'absent', mutation_certainty: 'present' }),
      verify,
    });
    assert.equal(result.state, 'IDLE');
    assert.deepEqual(kernel.inspect().map(x => [x.id, x.status]), [['a', 'DONE'], ['b', 'DONE']]);
    const receipts = kernel.receipts();
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(x => x.verified && x.disposition === 'DONE'));
    assert.notEqual(receipts[0].settlement_commit, receipts[1].settlement_commit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor success alone cannot settle DONE', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const result = await runGitCoreLoop(kernel, {
      maxAdvances: 1,
      execute: async () => ({ kind: 'ok' }),
      observe: async () => ({ effect: 'absent', mutation_certainty: 'absent' }),
      verify,
    });
    assert.equal(result.state, 'BUDGET_EXHAUSTED');
    assert.equal(kernel.inspect()[0].status, 'READY');
    assert.equal(kernel.receipts().at(-1).disposition, 'READY');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settlement refuses unverified DONE', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    const run = kernel.claim('x', work.revision);
    assert.throws(() => kernel.settle(run.id, { disposition: 'DONE', observed: { effect: 'absent' } }), /UNVERIFIED_DONE/);
    assert.equal(kernel.inspect()[0].status, 'EXECUTING');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uncertain external effect is not replayed', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    let executions = 0;
    const first = await runGitCoreLoop(kernel, {
      execute: async () => { executions += 1; return { kind: 'timeout', may_have_mutated: true }; },
      observe: async () => ({ effect: 'unknown', mutation_certainty: 'uncertain' }),
      verify,
    });
    const second = await runGitCoreLoop(kernel, {
      execute: async () => { executions += 1; return { kind: 'ok' }; },
      observe: async () => ({ effect: 'present', mutation_certainty: 'present' }),
      verify,
    });
    assert.equal(first.state, 'RECOVERY_REQUIRED');
    assert.equal(second.state, 'IDLE');
    assert.equal(executions, 1);
    assert.equal(kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart converts an interrupted claim into a recovery commit instead of replay', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    const run = kernel.claim('x', work.revision);
    const restarted = new GitOvercenterKernel(dir);
    assert.equal(restarted.recoverInterrupted(), 1);
    assert.equal(restarted.inspect()[0].status, 'RECOVERY_REQUIRED');
    let executions = 0;
    await runGitCoreLoop(restarted, {
      execute: async () => { executions += 1; return { kind: 'ok' }; },
      observe: async () => ({ effect: 'present', mutation_certainty: 'present' }),
      verify,
    });
    assert.equal(executions, 0);
    const receipt = restarted.receipts(run.id).at(-1);
    assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    assert.equal(parent(dir, receipt.settlement_commit), receipt.claim_commit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('later observation reconciles uncertain work to DONE without replay', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    const run = kernel.claim('x', work.revision);
    kernel.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed: { effect: 'unknown', mutation_certainty: 'uncertain' } });
    const reconciled = kernel.reconcile(run.id, { effect: 'present', mutation_certainty: 'present' }, verify);
    assert.equal(reconciled.disposition, 'DONE');
    assert.equal(kernel.inspect()[0].status, 'DONE');
    const receipts = kernel.receipts(run.id);
    assert.deepEqual(receipts.map(x => x.disposition), ['RECOVERY_REQUIRED', 'DONE']);
    assert.ok(receipts.every(x => x.claim_commit === run.claim_commit));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lost settlement acknowledgement is harmless because the ref already contains DONE', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    const run = kernel.claim('x', work.revision);
    kernel.settle(run.id, { disposition: 'DONE', verify, observed: { effect: 'present', mutation_certainty: 'present' } });
    const restarted = new GitOvercenterKernel(dir);
    let executions = 0;
    const result = await runGitCoreLoop(restarted, {
      execute: async () => { executions += 1; return { kind: 'ok' }; },
      observe: async () => ({ effect: 'present', mutation_certainty: 'present' }),
      verify,
    });
    assert.equal(result.state, 'IDLE');
    assert.equal(executions, 0);
    assert.equal(restarted.inspect()[0].status, 'DONE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
