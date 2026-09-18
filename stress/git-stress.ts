import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel, runGitCoreLoop } from '../src/git-kernel.ts';

const verify = (post, observed) => post.effect === observed.effect;
const sourceUrl = new URL('../src/git-kernel.ts', import.meta.url).href;

function repo(args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-git-stress-'));
  execFileSync('git', ['init', '--bare', ...args, dir], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(dir);
  kernel.initialize();
  return { dir, kernel };
}

function state(dir) {
  return JSON.parse(execFileSync(
    'git',
    ['-C', dir, 'show', 'refs/overcenter/state:state.json'],
    { encoding: 'utf8' },
  ));
}

function childModule(code, args) {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', code, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

async function waitForFiles(paths) {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (paths.every(existsSync)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('worker barrier timeout');
}

function seeded(seed) {
  let x = seed >>> 0;
  return () => ((x = (1664525 * x + 1013904223) >>> 0) / 2 ** 32);
}

test('caller cannot forge DONE with a boolean claim of verification', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const run = kernel.claim('x', kernel.deriveReadyWork().revision);

    assert.throws(
      () => kernel.settle(run.id, {
        disposition: 'DONE',
        verified: true,
        observed: { effect: 'absent', mutation_certainty: 'absent' },
      }),
      /UNVERIFIED_DONE/,
    );
    assert.equal(kernel.inspect()[0].status, 'EXECUTING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only authoritative absence can make failed work replayable', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({
      id: 'x',
      packet: { effect: 'wanted' },
      postcondition: { effect: 'wanted' },
    });
    let executions = 0;

    const result = await runGitCoreLoop(kernel, {
      execute: async () => { executions += 1; return { kind: 'ok' }; },
      observe: async () => ({
        effect: 'wrong-but-real',
        mutation_certainty: 'present',
      }),
      verify,
      maxAdvances: 2,
    });

    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(executions, 1);
    assert.equal(kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim acknowledgement loss can return to READY only after observed absence', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const run = kernel.claim('x', kernel.deriveReadyWork().revision);

    const restarted = new GitOvercenterKernel(dir);
    restarted.recoverInterrupted();
    const reconciled = restarted.reconcile(
      run.id,
      { effect: 'absent', mutation_certainty: 'absent' },
      verify,
    );

    assert.equal(reconciled.disposition, 'READY');
    assert.equal(restarted.inspect()[0].status, 'READY');
    assert.notEqual(
      restarted.claim('x', restarted.deriveReadyWork().revision).id,
      run.id,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash after external effect but before observation never replays', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const run = kernel.claim('x', kernel.deriveReadyWork().revision);
    const world = new Set(['present']);

    const restarted = new GitOvercenterKernel(dir);
    restarted.recoverInterrupted();

    let executions = 0;
    await runGitCoreLoop(restarted, {
      execute: async () => {
        executions += 1;
        world.add('present');
        return { kind: 'ok' };
      },
      observe: async () => ({
        effect: world.has('present') ? 'present' : 'absent',
        mutation_certainty: 'present',
      }),
      verify,
    });

    assert.equal(executions, 0);
    assert.equal(restarted.inspect()[0].status, 'RECOVERY_REQUIRED');

    restarted.reconcile(
      run.id,
      { effect: 'present', mutation_certainty: 'present' },
      verify,
    );
    assert.equal(restarted.inspect()[0].status, 'DONE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ref-lock failure cannot partially claim work', () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const work = kernel.deriveReadyWork();
    const lock = join(dir, 'refs/overcenter/state.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'held');

    assert.throws(() => kernel.claim('x', work.revision), /CLAIM_LOST/);

    rmSync(lock, { force: true });
    assert.equal(kernel.head(), work.revision);
    assert.equal(kernel.inspect()[0].status, 'READY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer and verifier failures become durable recovery', async () => {
  for (const failure of ['observe', 'verify']) {
    const { dir, kernel } = repo();
    try {
      kernel.define({
        id: failure,
        packet: { effect: 'present' },
        postcondition: { effect: 'present' },
      });

      const result = await runGitCoreLoop(kernel, {
        execute: async () => ({ kind: 'ok' }),
        observe: async () => {
          if (failure === 'observe') throw new Error('observer offline');
          return { effect: 'present', mutation_certainty: 'present' };
        },
        verify: () => {
          if (failure === 'verify') throw new Error('verifier offline');
          return true;
        },
      });

      assert.equal(result.state, 'RECOVERY_REQUIRED');
      assert.equal(kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
      const receipt = kernel.receipts().at(-1);
      assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('loss of authoritative ref fails closed instead of silently reinitializing', async () => {
  const { dir, kernel } = repo();
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    execFileSync('git', ['-C', dir, 'update-ref', '-d', 'refs/overcenter/state']);

    assert.throws(
      () => kernel.define({ id: 'y', postcondition: { effect: 'y' } }),
      /NOT_INITIALIZED/,
    );
    await assert.rejects(
      () => runGitCoreLoop(kernel, {
        execute: async () => ({ kind: 'ok' }),
        observe: async () => ({ effect: 'present' }),
        verify,
      }),
      /NOT_INITIALIZED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reachable state and receipts survive aggressive gc and SHA-256 repositories', () => {
  const { dir, kernel } = repo(['--object-format=sha256']);
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    assert.equal(kernel.head().length, 64);

    const run = kernel.claim('x', kernel.deriveReadyWork().revision);
    kernel.settle(run.id, {
      disposition: 'DONE',
      observed: { effect: 'present', mutation_certainty: 'present' },
      verify,
    });
    const before = kernel.head();

    execFileSync('git', ['-C', dir, 'gc', '--prune=now'], { stdio: 'ignore' });

    const restarted = new GitOvercenterKernel(dir);
    assert.equal(restarted.head(), before);
    assert.equal(restarted.inspect()[0].status, 'DONE');
    assert.equal(restarted.receipts(run.id).at(-1).disposition, 'DONE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('32 simultaneous claimers produce exactly one authoritative claim', async () => {
  const { dir, kernel } = repo();
  const barrier = mkdtempSync(join(tmpdir(), 'overcenter-claim-barrier-'));
  try {
    kernel.define({ id: 'x', postcondition: { effect: 'present' } });
    const go = join(barrier, 'go');
    const ready = Array.from(
      { length: 32 },
      (_, i) => join(barrier, `ready-${i}`),
    );
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { GitOvercenterKernel } from ${JSON.stringify(sourceUrl)};
      const [repo, ready, go] = process.argv.slice(1);
      const kernel = new GitOvercenterKernel(repo);
      const work = kernel.deriveReadyWork();
      writeFileSync(ready, work.revision);
      while (!existsSync(go)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try {
        const run = kernel.claim(work.id, work.revision);
        process.stdout.write(JSON.stringify({ ok: true, run }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
    `;
    const workers = ready.map(path => childModule(code, [dir, path, go]));

    await waitForFiles(ready);
    assert.equal(
      new Set(ready.map(path => readFileSync(path, 'utf8'))).size,
      1,
    );
    writeFileSync(go, 'go');

    const results = (await Promise.all(workers))
      .map(result => JSON.parse(result.stdout));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(kernel.inspect()[0].status, 'EXECUTING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  }
});

test('32 simultaneous initializers converge on one root without surfacing contention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-init-race-'));
  const barrier = mkdtempSync(join(tmpdir(), 'overcenter-init-barrier-'));
  try {
    execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
    const go = join(barrier, 'go');
    const ready = Array.from(
      { length: 32 },
      (_, i) => join(barrier, `ready-${i}`),
    );
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { GitOvercenterKernel } from ${JSON.stringify(sourceUrl)};
      const [repo, ready, go] = process.argv.slice(1);
      const kernel = new GitOvercenterKernel(repo);
      writeFileSync(ready, 'ready');
      while (!existsSync(go)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try {
        process.stdout.write(JSON.stringify({ ok: true, head: kernel.initialize() }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
    `;
    const workers = ready.map(path => childModule(code, [dir, path, go]));

    await waitForFiles(ready);
    writeFileSync(go, 'go');

    const results = (await Promise.all(workers))
      .map(result => JSON.parse(result.stdout));
    assert.equal(results.filter(result => result.ok).length, 32);
    assert.equal(new Set(results.map(result => result.head)).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  }
});

test('16 complete loops racing one obligation execute the effect exactly once', async () => {
  const { dir, kernel } = repo();
  const barrier = mkdtempSync(join(tmpdir(), 'overcenter-loop-barrier-'));
  try {
    kernel.define({
      id: 'x',
      packet: { effect: 'present' },
      postcondition: { effect: 'present' },
    });
    const go = join(barrier, 'go');
    const effects = join(barrier, 'effects');
    writeFileSync(effects, '');
    const ready = Array.from(
      { length: 16 },
      (_, i) => join(barrier, `ready-${i}`),
    );
    const code = `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { GitOvercenterKernel, runGitCoreLoop } from ${JSON.stringify(sourceUrl)};
      const [repo, ready, go, effects, id] = process.argv.slice(1);
      class BarrierKernel extends GitOvercenterKernel {
        first = true;
        deriveReadyWork() {
          const work = super.deriveReadyWork();
          if (this.first) {
            this.first = false;
            writeFileSync(ready, work?.revision ?? 'none');
            while (!existsSync(go)) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
          return work;
        }
      }
      const kernel = new BarrierKernel(repo);
      try {
        const result = await runGitCoreLoop(kernel, {
          execute: async () => {
            appendFileSync(effects, id + '\\n');
            return { kind: 'ok' };
          },
          observe: async () => ({
            effect: 'present',
            mutation_certainty: 'present',
          }),
          verify: (post, observed) => post.effect === observed.effect,
        });
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
    `;
    const workers = ready.map((path, i) =>
      childModule(code, [dir, path, go, effects, String(i)]),
    );

    await waitForFiles(ready);
    assert.equal(
      new Set(ready.map(path => readFileSync(path, 'utf8'))).size,
      1,
    );
    writeFileSync(go, 'go');

    const results = (await Promise.all(workers))
      .map(result => JSON.parse(result.stdout));
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(
      readFileSync(effects, 'utf8').trim().split(/\n/).filter(Boolean).length,
      1,
    );
    assert.equal(kernel.inspect()[0].status, 'DONE');
    assert.equal(
      kernel.receipts().filter(receipt => receipt.disposition === 'DONE').length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  }
});

test('premature recovery of a still-live worker cannot cause replay or false DONE', async () => {
  const { dir, kernel: worker } = repo();
  try {
    worker.define({ id: 'x', postcondition: { effect: 'present' } });
    const run = worker.claim('x', worker.deriveReadyWork().revision);

    const other = new GitOvercenterKernel(dir);
    other.recoverInterrupted();

    const lateSettlement = worker.settle(run.id, {
      disposition: 'DONE',
      observed: { effect: 'present', mutation_certainty: 'present' },
      verify,
    });
    assert.equal(lateSettlement.disposition, 'RECOVERY_REQUIRED');
    assert.equal(worker.inspect()[0].status, 'RECOVERY_REQUIRED');

    let executions = 0;
    await runGitCoreLoop(worker, {
      execute: async () => { executions += 1; return { kind: 'ok' }; },
      observe: async () => ({
        effect: 'present',
        mutation_certainty: 'present',
      }),
      verify,
    });
    assert.equal(executions, 0);

    worker.reconcile(
      run.id,
      { effect: 'present', mutation_certainty: 'present' },
      verify,
    );
    assert.equal(worker.inspect()[0].status, 'DONE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seeded crash/recovery state machine preserves terminal receipt invariants', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const { dir, kernel } = repo();
    const random = seeded(seed);
    try {
      for (let i = 0; i < 8; i += 1) {
        kernel.define({
          id: `w${String(i).padStart(2, '0')}`,
          deps: i ? [`w${String(i - 1).padStart(2, '0')}`] : [],
          packet: { effect: `e${i}` },
          postcondition: { effect: `e${i}` },
        });
      }

      for (let step = 0; step < 80; step += 1) {
        const ready = kernel.deriveReadyWork();
        if (!ready) {
          const blocked = Object.values(state(dir).obligations)
            .find(work => work.status === 'RECOVERY_REQUIRED');
          if (!blocked) break;

          const choice = random();
          const observed = choice < 0.45
            ? { effect: blocked.postcondition.effect, mutation_certainty: 'present' }
            : choice < 0.8
              ? { effect: 'absent', mutation_certainty: 'absent' }
              : { effect: 'unknown', mutation_certainty: 'uncertain' };
          kernel.reconcile(blocked.run_id, observed, verify);
          continue;
        }

        const run = kernel.claim(ready.id, ready.revision);
        const choice = random();
        if (choice < 0.2) {
          kernel.recoverInterrupted();
        } else if (choice < 0.4) {
          kernel.settle(run.id, {
            disposition: 'RECOVERY_REQUIRED',
            observed: { effect: 'unknown', mutation_certainty: 'uncertain' },
          });
        } else if (choice < 0.6) {
          kernel.settle(run.id, {
            disposition: 'READY',
            observed: { effect: 'absent', mutation_certainty: 'absent' },
          });
        } else {
          kernel.settle(run.id, {
            disposition: 'DONE',
            observed: {
              effect: ready.postcondition.effect,
              mutation_certainty: 'present',
            },
            verify,
          });
        }

        const current = state(dir);
        const executing = Object.values(current.obligations)
          .filter(work => work.status === 'EXECUTING');
        assert.equal(executing.length, current.active_run ? 1 : 0);
      }

      const current = state(dir);
      const receipts = kernel.receipts();
      for (const work of Object.values(current.obligations)
        .filter(item => item.status === 'DONE')) {
        const done = receipts
          .filter(receipt =>
            receipt.obligation_id === work.id
            && receipt.disposition === 'DONE')
          .at(-1);
        assert.ok(done, `DONE ${work.id} lacks receipt`);
        assert.equal(done.verified, true);
        execFileSync(
          'git',
          ['-C', dir, 'merge-base', '--is-ancestor', done.claim_commit, done.settlement_commit],
          { stdio: 'ignore' },
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
