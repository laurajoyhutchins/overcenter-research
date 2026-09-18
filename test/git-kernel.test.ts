import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel, runGitCoreLoop } from '../src/git-kernel.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'git-kernel-v2-'));
  const repo = join(root, 'state.git');
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(repo);
  kernel.initialize();
  return { root, repo, kernel, path: (name: string) => join(root, name) };
}
const pc = (path: string, content: string) => ({ verifier: 'file-content-equals/v1' as const, path, content });

test('commit SHA is the authoritative revision and claim is its child', () => {
  const f = fixture();
  try {
    f.kernel.define({ id: 'x', postcondition: pc(f.path('x'), 'yes') });
    const w = f.kernel.deriveReadyWork()!;
    const run = f.kernel.claim('x', w.revision);
    const parent = execFileSync('git', ['-C', f.repo, 'rev-parse', `${run.claim_commit}^`], { encoding: 'utf8' }).trim();
    assert.equal(parent, w.revision);
    assert.equal(f.kernel.head(), run.claim_commit);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('kernel-owned evidence drives dependency chain to DONE', async () => {
  const f = fixture();
  try {
    const a = f.path('a'), b = f.path('b');
    f.kernel.define({ id: 'a', packet: { path: a, content: 'A' }, postcondition: pc(a, 'A') });
    f.kernel.define({ id: 'b', deps: ['a'], packet: { path: b, content: 'B' }, postcondition: pc(b, 'B') });
    const result = await runGitCoreLoop(f.kernel, {
      execute: async packet => {
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });
    assert.equal(result.state, 'IDLE');
    assert.deepEqual(f.kernel.inspect().map(x => [x.id, x.status]), [['a', 'DONE'], ['b', 'DONE']]);
    assert.ok(f.kernel.receipts().every(x => x.verified));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wrong real effect cannot become DONE or READY', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'right') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'wrong');
    const receipt = f.kernel.resolve(run.id);
    assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    assert.equal(receipt.verified, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('authoritative absence alone makes work replayable', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'yes') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    const receipt = f.kernel.resolve(run.id);
    assert.equal(receipt.disposition, 'READY');
    assert.equal(f.kernel.inspect()[0].status, 'READY');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('kernel-owned Git ref verifier reads independent remote truth', () => {
  const f = fixture();
  try {
    const external = f.path('external.git');
    execFileSync('git', ['init', '--bare', external], { stdio: 'ignore' });
    const target = f.kernel.head()!;
    const ref = 'refs/tags/provider-proof';
    f.kernel.define({
      id: 'provider',
      postcondition: { verifier: 'git-ref-equals/v1', remote: external, ref, target_sha: target },
    });
    const run = f.kernel.claim('provider', f.kernel.deriveReadyWork()!.revision);
    execFileSync('git', ['-C', f.repo, 'push', external, `${target}:${ref}`], { stdio: 'ignore' });
    const receipt = f.kernel.resolve(run.id);
    assert.equal(receipt.disposition, 'DONE');
    assert.equal(receipt.observed?.actual_sha, target);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('stale revision claim is fenced', () => {
  const f = fixture();
  try {
    f.kernel.define({ id: 'x', postcondition: pc(f.path('x'), 'yes') });
    assert.throws(() => f.kernel.claim('x', '0'.repeat(40)), /STALE_REVISION/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('interrupted exact run reconciles to DONE without replay', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'yes') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'yes');
    f.kernel.recoverInterrupted(run.id, { source: 'supervisor' });
    const receipt = f.kernel.reconcile(run.id);
    assert.equal(receipt.disposition, 'DONE');
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('DONE resolution is idempotent after lost acknowledgement', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'yes') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'yes');
    const first = f.kernel.resolve(run.id);
    const second = f.kernel.resolve(run.id);
    assert.equal(first.disposition, 'DONE');
    assert.equal(second.settlement_commit, first.settlement_commit);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('all observational surfaces fail closed when authority is missing', () => {
  const f = fixture();
  try {
    execFileSync('git', ['-C', f.repo, 'update-ref', '-d', 'refs/overcenter/state']);
    assert.throws(() => f.kernel.inspect(), /NOT_INITIALIZED/);
    assert.throws(() => f.kernel.deriveReadyWork(), /NOT_INITIALIZED/);
    assert.throws(() => f.kernel.receipts(), /NOT_INITIALIZED/);
    assert.throws(() => f.kernel.recoverInterrupted('x'), /NOT_INITIALIZED/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('kernel state never persists lifecycle status or cached claim commit', () => {
  const f = fixture();
  try {
    const path = f.path('derived-state');
    f.kernel.define({
      id: 'x',
      postcondition: pc(path, 'present'),
    });

    const state = () => JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${f.kernel.head()}:state.json`],
        { encoding: 'utf8' },
      ),
    ) as { obligations: Record<string, Record<string, unknown>> };

    const assertDerivedOnly = () => {
      const stored = state().obligations.x;
      assert.ok(stored);
      assert.equal('status' in stored, false);
      assert.equal('run_id' in stored, false);
      assert.equal('claimed_revision' in stored, false);
      assert.equal('claim_commit' in stored, false);
    };

    assert.equal(f.kernel.inspect()[0].status, 'READY');
    assertDerivedOnly();

    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    assert.equal(f.kernel.inspect()[0].status, 'EXECUTING');
    assertDerivedOnly();

    const recovery = f.kernel.recoverInterrupted(run.id, { source: 'test' });
    assert.equal(recovery.disposition, 'RECOVERY_REQUIRED');
    assert.equal(recovery.claim_commit, run.claim_commit);
    assert.equal(f.kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
    assertDerivedOnly();

    writeFileSync(path, 'present');
    const settled = f.kernel.reconcile(run.id);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.claim_commit, run.claim_commit);
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
    assertDerivedOnly();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
