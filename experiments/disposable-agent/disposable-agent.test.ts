import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function cloneAgent(authority: string, path: string) {
  execFileSync('git', ['init', '--bare', path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', authority], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'fetch', '--no-tags', 'origin', '+refs/overcenter/state:refs/overcenter/state'], { stdio: 'ignore' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reis-handoff-'));
  const authority = join(root, 'authority.git');
  const world = join(root, 'external-truth.txt');
  const supervisor = join(root, 'supervisor.json');

  execFileSync('git', ['init', '--bare', authority], { stdio: 'ignore' });
  const owner = new GitOvercenterKernel(authority);
  owner.initialize();
  owner.define({
    id: 'effect',
    packet: { path: world, content: 'present' },
    postcondition: { verifier: 'file-content-equals/v1', path: world, content: 'present' },
  });

  return { root, authority, world, supervisor };
}

test('entire Agent A sandbox can disappear and fresh Agent B reconstructs and settles from Git authority', () => {
  const f = fixture();
  try {
    const a = join(f.root, 'agent-a.git');
    cloneAgent(f.authority, a);
    const agentA = new GitOvercenterKernel(a, { remote: 'origin' });
    const ready = agentA.deriveReadyWork()!;
    assert.equal(ready.id, 'effect');
    const run = agentA.claim(ready.id, ready.revision);

    writeFileSync(join(a, 'agent-cache.sqlite'), 'throw me away');

    agentA.beginEffect(run);
    writeFileSync(f.world, 'present');
    const claimCommit = run.claim_commit;
    rmSync(a, { recursive: true, force: true });
    assert.equal(existsSync(a), false);

    writeFileSync(f.supervisor, JSON.stringify({ run_id: run.id, status: 'terminated' }));

    const b = join(f.root, 'agent-b.git');
    cloneAgent(f.authority, b);
    assert.equal(existsSync(join(b, 'agent-cache.sqlite')), false);
    const agentB = new GitOvercenterKernel(b, { remote: 'origin' });

    const unresolved = agentB.inspect().find(x => x.id === 'effect');
    assert.equal(unresolved?.status, 'EXECUTING');
    assert.equal(unresolved?.run_id, run.id);

    const termination = JSON.parse(readFileSync(f.supervisor, 'utf8'));
    const recovery = agentB.acquireExecution(termination.run_id);
    assert.equal(recovery.execution_generation, 2);
    agentB.recoverInterrupted(recovery, { source: 'sandbox-supervisor' });
    const done = agentB.reconcile(recovery);

    assert.equal(done.disposition, 'DONE');
    assert.equal(done.verified, true);
    assert.equal(agentB.inspect()[0].status, 'DONE');
    assert.equal(readFileSync(f.world, 'utf8'), 'present');

    const receipts = agentB.receipts(run.id);
    assert.deepEqual(receipts.map(x => x.disposition), ['RECOVERY_REQUIRED', 'DONE']);
    assert.ok(receipts.every(x => x.claim_commit === claimCommit));
    execFileSync('git', ['-C', b, 'merge-base', '--is-ancestor', claimCommit, done.settlement_commit!]);

    const authorityKernel = new GitOvercenterKernel(f.authority);
    assert.equal(authorityKernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('kernel-owned verifier cannot be replaced by the agent', () => {
  const f = fixture();
  try {
    const a = join(f.root, 'a.git');
    cloneAgent(f.authority, a);
    const k = new GitOvercenterKernel(a, { remote: 'origin' });
    const work = k.deriveReadyWork()!;
    const run = k.claim(work.id, work.revision);
    k.beginEffect(run);
    writeFileSync(f.world, 'wrong');
    const result = k.resolve(run);

    assert.equal(result.disposition, 'RECOVERY_REQUIRED');
    assert.equal(result.verified, false);
    assert.equal(result.observed?.actual_sha256 === result.observed?.expected_sha256, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('READY reconciliation is idempotent after lost acknowledgement', () => {
  const f = fixture();
  try {
    const a = join(f.root, 'a.git');
    cloneAgent(f.authority, a);
    const k = new GitOvercenterKernel(a, { remote: 'origin' });
    const work = k.deriveReadyWork()!;
    const run = k.claim(work.id, work.revision);

    k.recoverInterrupted(run, { source: 'supervisor' });
    const first = k.reconcile(run);
    assert.equal(first.disposition, 'READY');

    const second = k.reconcile(run);
    assert.equal(second.disposition, 'READY');
    assert.equal(second.settlement_commit, first.settlement_commit);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('missing remote authority never looks empty or idle', () => {
  const f = fixture();
  try {
    const b = join(f.root, 'b.git');
    cloneAgent(f.authority, b);
    const k = new GitOvercenterKernel(b, { remote: 'origin' });
    git(f.authority, ['update-ref', '-d', 'refs/overcenter/state']);

    assert.throws(() => k.inspect(), /NOT_INITIALIZED/);
    assert.throws(() => k.deriveReadyWork(), /NOT_INITIALIZED/);
    assert.throws(() => k.receipts(), /NOT_INITIALIZED/);
    assert.throws(() => k.recoverInterrupted({id:'x'} as never), /NOT_INITIALIZED/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('two disposable clones CAS against central authority and exactly one claim wins', () => {
  const f = fixture();
  try {
    const a = join(f.root, 'a.git');
    const b = join(f.root, 'b.git');
    cloneAgent(f.authority, a);
    cloneAgent(f.authority, b);

    const ka = new GitOvercenterKernel(a, { remote: 'origin' });
    const kb = new GitOvercenterKernel(b, { remote: 'origin' });
    const wa = ka.deriveReadyWork()!;
    const wb = kb.deriveReadyWork()!;
    assert.equal(wa.revision, wb.revision);

    ka.claim(wa.id, wa.revision);
    assert.throws(() => kb.claim(wb.id, wb.revision), /STALE_REVISION|CLAIM_LOST/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
