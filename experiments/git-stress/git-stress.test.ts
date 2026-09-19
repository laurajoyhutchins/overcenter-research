import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

const source = new URL('../../src/storage/git-kernel.ts', import.meta.url).href;

function bare(root: string, name = 'state.git', args: string[] = []) {
  const repo = join(root, name);
  execFileSync('git', ['init', '--bare', ...args, repo], { stdio: 'ignore' });
  return repo;
}

function cloneAgent(authority: string, path: string) {
  execFileSync('git', ['init', '--bare', path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', authority], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'fetch', '--no-tags', 'origin', '+refs/overcenter/state:refs/overcenter/state'], { stdio: 'ignore' });
}

function child(code: string, args: string[]) {
  return new Promise<{ out: string; err: string }>(resolve => {
    const p = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', x => { out += x; });
    p.stderr.on('data', x => { err += x; });
    p.on('close', () => resolve({ out, err }));
  });
}

async function wait(paths: string[]) {
  for (let i = 0; i < 5000; i += 1) {
    if (paths.every(existsSync)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('barrier timeout');
}

const pc = (path: string, content: string) => ({ verifier: 'file-content-equals/v1' as const, path, content });

test('ref lock cannot partially claim local authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'ref-lock-'));
  try {
    const repo = bare(root);
    const k = new GitOvercenterKernel(repo);
    k.initialize();
    k.define({ id: 'x', postcondition: pc(join(root, 'x'), 'yes') });
    const w = k.deriveReadyWork()!;
    const lock = join(repo, 'refs/overcenter/state.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'held');
    assert.throws(() => k.claim('x', w.revision), /CLAIM_LOST/);
    rmSync(lock);
    assert.equal(k.inspect()[0].status, 'READY');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reachable state and receipts survive aggressive GC in SHA-256 repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'sha256-'));
  try {
    const repo = bare(root, 'state.git', ['--object-format=sha256']);
    const path = join(root, 'world');
    const k = new GitOvercenterKernel(repo);
    k.initialize();
    k.define({ id: 'x', postcondition: pc(path, 'yes') });
    const run = k.claim('x', k.deriveReadyWork()!.revision);
    k.beginEffect(run);
    writeFileSync(path, 'yes');
    k.resolve(run);
    const head = k.head();
    assert.equal(head?.length, 64);
    execFileSync('git', ['-C', repo, 'gc', '--prune=now'], { stdio: 'ignore' });
    const restarted = new GitOvercenterKernel(repo);
    assert.equal(restarted.head(), head);
    assert.equal(restarted.inspect()[0].status, 'DONE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('16 disposable clones CAS one central authority and exactly one claims', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-race-'));
  try {
    const authority = bare(root, 'authority.git');
    const world = join(root, 'world');
    const owner = new GitOvercenterKernel(authority);
    owner.initialize();
    owner.define({ id: 'x', postcondition: pc(world, 'yes') });

    const go = join(root, 'go');
    const ready = Array.from({ length: 16 }, (_, i) => join(root, `ready-${i}`));
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { GitOvercenterKernel } from ${JSON.stringify(source)};
      const [authority, repo, ready, go] = process.argv.slice(1);
      execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', authority], { stdio: 'ignore' });
      execFileSync('git', ['-C', repo, 'fetch', '--no-tags', 'origin', '+refs/overcenter/state:refs/overcenter/state'], { stdio: 'ignore' });
      const k = new GitOvercenterKernel(repo, { remote: 'origin' });
      const w = k.deriveReadyWork();
      writeFileSync(ready, w.revision);
      while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      try {
        const run = k.claim(w.id, w.revision);
        process.stdout.write(JSON.stringify({ ok: true, id: run.id }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
    `;

    const workers = ready.map((path, i) => child(code, [authority, join(root, `a-${i}.git`), path, go]));
    await wait(ready);
    assert.equal(new Set(ready.map(path => readFileSync(path, 'utf8'))).size, 1);
    writeFileSync(go, 'go');

    const results = (await Promise.all(workers)).map(x => JSON.parse(x.out));
    assert.equal(results.filter(x => x.ok).length, 1, JSON.stringify(results));
    assert.equal(owner.inspect()[0].status, 'EXECUTING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fresh clone can resolve a remote claim after claimant directory is destroyed', () => {
  const root = mkdtempSync(join(tmpdir(), 'destroy-'));
  try {
    const authority = bare(root, 'authority.git');
    const world = join(root, 'world');
    const owner = new GitOvercenterKernel(authority);
    owner.initialize();
    owner.define({ id: 'x', postcondition: pc(world, 'yes') });

    const a = join(root, 'a.git');
    cloneAgent(authority, a);
    const ka = new GitOvercenterKernel(a, { remote: 'origin' });
    const run = ka.claim('x', ka.deriveReadyWork()!.revision);
    ka.beginEffect(run);
    writeFileSync(world, 'yes');
    rmSync(a, { recursive: true, force: true });

    const b = join(root, 'b.git');
    cloneAgent(authority, b);
    const kb = new GitOvercenterKernel(b, { remote: 'origin' });
    const recovery = kb.acquireExecution(run.id);
    assert.equal(recovery.execution_generation, 2);
    kb.recoverInterrupted(recovery, { source: 'supervisor' });
    const done = kb.reconcile(recovery);
    assert.equal(done.disposition, 'DONE');
    assert.equal(owner.inspect()[0].status, 'DONE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
