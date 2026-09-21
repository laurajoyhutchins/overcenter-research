import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import { runCoreLoop } from '../src/kernel-core.ts';
import { RECEIPT_SCHEMA } from '../src/facts.ts';

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
    f.kernel.define({ id: 'b', dependencies: [{ kind: 'control', upstream: 'a' }], packet: { path: b, content: 'B' }, postcondition: pc(b, 'B') });
    const result = await runCoreLoop(f.kernel, {
      effect: async packet => {
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });
    assert.equal(result.state, 'IDLE');
    assert.deepEqual(f.kernel.inspect().map(x => [x.id, x.status]), [['a', 'DONE'], ['b', 'DONE']]);
    assert.ok(f.kernel.receipts().every(x => x.verified));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('core loop commits an effect reservation before invoking effect handler', async () => {
  const f = fixture();
  try {
    const path = f.path('reserved-core-loop');
    f.kernel.define({
      id: 'x',
      packet: { path, content: 'present' },
      postcondition: pc(path, 'present'),
    });

    let effectObservedReservation = false;
    const result = await runCoreLoop(f.kernel, {
      effect: async (...args) => {
        assert.equal(args.length, 1, 'effect callback must not receive ExecutionPermit');
        const [packet] = args;
        const head = f.kernel.head()!;
        const reservation = JSON.parse(
          execFileSync(
            'git',
            ['-C', f.repo, 'show', `${head}:effect-reservation.json`],
            { encoding: 'utf8' },
          ),
        ) as Record<string, unknown>;
        const executing = f.kernel.inspect().find(work => work.id === 'x')!;
        assert.equal(reservation.run_id, executing.run_id);
        assert.equal(reservation.execution_generation, executing.execution_generation);
        effectObservedReservation = true;
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });

    assert.equal(effectObservedReservation, true);
    assert.equal(result.state, 'IDLE');
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('core loop never invokes effect handler when effect reservation cannot commit', async () => {
  const f = fixture();
  try {
    const path = f.path('reservation-failure');
    const lock = join(f.repo, 'refs/overcenter/state.lock');
    f.kernel.define({
      id: 'x',
      packet: { path, content: 'present' },
      postcondition: pc(path, 'present'),
    });

    let executions = 0;
    await assert.rejects(
      runCoreLoop(f.kernel, {
        preflight: async () => {
          writeFileSync(lock, 'held');
          return { kind: 'execute' };
        },
        effect: async packet => {
          executions += 1;
          writeFileSync(String(packet.path), String(packet.content));
          return { kind: 'ok' };
        },
      }),
      /EFFECT_RESERVATION_CONTENTION_EXHAUSTED/,
    );

    assert.equal(executions, 0);
    assert.equal(f.kernel.inspect()[0].status, 'EXECUTING');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('preflight judgment can WAIT without opening the effect boundary', async () => {
  const f = fixture();
  try {
    const path = f.path('preflight-judgment');
    f.kernel.define({
      id: 'x',
      packet: { path, content: 'present' },
      postcondition: pc(path, 'present'),
    });

    let executions = 0;
    const result = await runCoreLoop(f.kernel, {
      preflight: async () => ({
        kind: 'judgment-required',
        question: 'human choice required',
      }),
      effect: async () => {
        executions += 1;
        return { kind: 'ok' };
      },
    });

    assert.equal(result.state, 'WAITING');
    assert.equal(executions, 0);
    assert.equal(f.kernel.inspect()[0].status, 'WAITING');

    const commits = execFileSync(
      'git',
      ['-C', f.repo, 'rev-list', 'refs/overcenter/state'],
      { encoding: 'utf8' },
    ).trim().split(/\n+/).filter(Boolean);
    for (const commit of commits) {
      assert.throws(
        () => execFileSync(
          'git',
          ['-C', f.repo, 'cat-file', '-e', `${commit}:effect-reservation.json`],
          { stdio: 'ignore' },
        ),
      );
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('post-reservation judgment is recovery uncertainty, not WAITING', async () => {
  const f = fixture();
  try {
    const path = f.path('late-judgment');
    f.kernel.define({
      id: 'x',
      packet: { path, content: 'present' },
      postcondition: pc(path, 'present'),
    });

    const result = await runCoreLoop(f.kernel, {
      effect: async () => ({
        kind: 'judgment-required',
        question: 'too late to assert no effect',
      }),
    });

    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(f.kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
    assert.deepEqual(
      f.kernel.receipts(result.run!).map(receipt => receipt.disposition),
      ['RECOVERY_REQUIRED'],
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wrong real effect cannot become DONE or READY', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'right') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'wrong');
    const receipt = f.kernel.resolve(run);
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
    const receipt = f.kernel.resolve(run);
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.equal(receipt.observed?.mutation_certainty, 'absent');
    assert.equal(receipt.observed?.absence_evidence?.kind, 'local-file-enoent/v1');
    assert.equal(receipt.observed?.absence_evidence?.subject.path, path);
    assert.equal(receipt.observed?.absence_evidence?.completeness.result, 'ENOENT');
    assert.equal(receipt.observed?.absence_evidence?.provenance.error_code, 'ENOENT');
    assert.equal('negative_evidence_authoritative' in receipt.observed!, false);
    assert.equal(receipt.disposition, 'READY');
    assert.equal(f.kernel.inspect()[0].status, 'READY');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('stale revision claim is fenced', () => {
  const f = fixture();
  try {
    f.kernel.define({ id: 'x', postcondition: pc(f.path('x'), 'yes') });
    assert.throws(() => f.kernel.claim('x', '0'.repeat(40)), /STALE_REVISION/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('execution generation fences a stale permit without changing the claimed revision', () => {
  const f = fixture();
  try {
    const path = f.path('generation-fence');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });
    const first = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    const second = f.kernel.acquireExecution(first.id);

    assert.equal(first.claimed_revision, second.claimed_revision);
    assert.equal(first.execution_generation, 1);
    assert.equal(second.execution_generation, 2);
    assert.notEqual(first.execution_authority_commit, second.execution_authority_commit);
    assert.notEqual(first.execution_capability, second.execution_capability);

    const persistedClaim = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${first.claim_commit}:claim.json`],
        { encoding: 'utf8' },
      ),
    ) as Record<string, unknown>;
    assert.equal(JSON.stringify(persistedClaim).includes(first.execution_capability), false);
    assert.equal(
      persistedClaim.execution_capability_sha256,
      first.execution_capability_sha256,
    );

    const persistedAuthority = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${second.execution_authority_commit}:execution-authority.json`],
        { encoding: 'utf8' },
      ),
    ) as Record<string, unknown>;
    assert.equal(JSON.stringify(persistedAuthority).includes(second.execution_capability), false);
    assert.equal(
      persistedAuthority.execution_capability_sha256,
      second.execution_capability_sha256,
    );

    assert.throws(() => f.kernel.beginEffect(first), /STALE_EXECUTION_GENERATION/);
    assert.throws(() => f.kernel.resolve(first), /STALE_EXECUTION_GENERATION/);

    f.kernel.beginEffect(second);
    const replayable = f.kernel.resolve(second);
    assert.equal(replayable.disposition, 'READY');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unresolved effect reservation survives generation handoff until presence settles it', async () => {
  const f = fixture();
  try {
    const path = f.path('reserved-present');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });
    const first = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);

    await f.kernel.performEffect(first, async () => {
      writeFileSync(path, 'present');
    });

    const second = f.kernel.acquireExecution(first.id);
    assert.throws(() => f.kernel.beginEffect(second), /UNRESOLVED_EFFECT/);
    assert.throws(() => f.kernel.resolve(first), /STALE_EXECUTION_GENERATION/);

    const settled = f.kernel.resolve(second);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('only authoritative absence releases an unresolved reservation for replay', () => {
  const f = fixture();
  try {
    const path = f.path('reserved-absent');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });
    const first = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    f.kernel.beginEffect(first);

    const second = f.kernel.acquireExecution(first.id);
    assert.throws(() => f.kernel.beginEffect(second), /UNRESOLVED_EFFECT/);

    const absent = f.kernel.resolve(second);
    assert.equal(absent.disposition, 'READY');

    const retry = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    assert.equal(retry.execution_generation, 1);
    assert.doesNotThrow(() => f.kernel.beginEffect(retry));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('interrupted exact run reconciles to DONE without replay', () => {
  const f = fixture();
  try {
    const path = f.path('x');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'yes') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'yes');
    f.kernel.recoverInterrupted(run, { source: 'supervisor' });
    const receipt = f.kernel.reconcile(run);
    assert.equal(receipt.disposition, 'DONE');
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('supervisor rotates execution authority before recovering a dead worker', () => {
  const f = fixture();
  try {
    const path = f.path('supervisor-recovery');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'yes') });
    const worker = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'yes');

    const supervisor = f.kernel.acquireExecution(worker.id);
    assert.equal(supervisor.id, worker.id);
    assert.equal(supervisor.execution_generation, worker.execution_generation + 1);
    assert.throws(
      () => f.kernel.recoverInterrupted(worker, { source: 'stale-worker' }),
      /STALE_EXECUTION_GENERATION/,
    );

    const recovery = f.kernel.recoverInterrupted(supervisor, { source: 'supervisor' });
    assert.equal(recovery.disposition, 'RECOVERY_REQUIRED');
    const settled = f.kernel.reconcile(supervisor);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
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
    const first = f.kernel.resolve(run);
    const second = f.kernel.resolve(run);
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
    assert.throws(() => f.kernel.explain('x'), /NOT_INITIALIZED/);
    assert.throws(() => f.kernel.receipts(), /NOT_INITIALIZED/);
    assert.throws(() => f.kernel.recoverInterrupted({id:'x'} as never), /NOT_INITIALIZED/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('authority history contains no state snapshot and receipts remain factual', () => {
  const f = fixture();
  try {
    const path = f.path('derived-state');
    f.kernel.define({
      id: 'x',
      postcondition: pc(path, 'present'),
    });

    const assertNoStateSnapshot = () => {
      const commits = execFileSync(
        'git',
        ['-C', f.repo, 'rev-list', 'refs/overcenter/state'],
        { encoding: 'utf8' },
      ).trim().split(/\n+/).filter(Boolean);

      for (const commit of commits) {
        assert.throws(
          () => execFileSync(
            'git',
            ['-C', f.repo, 'cat-file', '-e', `${commit}:state.json`],
            { stdio: 'ignore' },
          ),
        );
      }
    };

    assert.equal(f.kernel.inspect()[0].status, 'READY');
    assertNoStateSnapshot();

    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    assert.equal(f.kernel.inspect()[0].status, 'EXECUTING');
    assertNoStateSnapshot();

    const recovery = f.kernel.recoverInterrupted(run, { source: 'test' });
    assert.equal(recovery.disposition, 'RECOVERY_REQUIRED');
    assert.equal(recovery.verified, false);
    assert.equal(recovery.claim_commit, run.claim_commit);
    assert.equal(f.kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
    assertNoStateSnapshot();

    const persistedRecovery = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${recovery.settlement_commit}:receipt.json`],
        { encoding: 'utf8' },
      ),
    ) as Record<string, unknown>;
    assert.equal(persistedRecovery.kind, 'execution-terminated');
    assert.equal('disposition' in persistedRecovery, false);
    assert.equal('verified' in persistedRecovery, false);

    writeFileSync(path, 'present');
    const settled = f.kernel.reconcile(run);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(settled.claim_commit, run.claim_commit);
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
    assertNoStateSnapshot();

    const persistedSettlement = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${settled.settlement_commit}:receipt.json`],
        { encoding: 'utf8' },
      ),
    ) as {
      kind?: string;
      observed?: Record<string, unknown> | null;
      [key: string]: unknown;
    };
    assert.equal(persistedSettlement.kind, 'observation');
    assert.equal('disposition' in persistedSettlement, false);
    assert.equal('verified' in persistedSettlement, false);
    assert.ok(persistedSettlement.observed);
    assert.equal('verified' in persistedSettlement.observed!, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('historical receipt stays bound to the immutable definition claimed by its run', () => {
  const f = fixture();
  try {
    const path = f.path('generation');
    f.kernel.define({
      id: 'x',
      packet: { generation: 1 },
      postcondition: pc(path, 'one'),
    });

    const firstRun = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'one');
    const firstDone = f.kernel.resolve(firstRun);
    assert.equal(firstDone.disposition, 'DONE');
    assert.equal(firstDone.verified, true);

    const beforeRebind = f.kernel.head()!;
    f.kernel.applyGraphPatch({
      upsert:[{
        id: 'x',
        packet: { generation: 2 },
        postcondition: pc(path, 'two'),
      }],
    }, beforeRebind);

    const rebound = f.kernel.inspect()[0];
    assert.equal(rebound.status, 'READY');
    assert.deepEqual(rebound.packet, { generation: 2 });
    assert.deepEqual(rebound.postcondition, pc(path, 'two'));

    // The historical observation remains interpreted against the exact
    // immutable definition captured when the run was claimed.
    const oldReceipt = f.kernel.receipts(firstRun.id).at(-1)!;
    assert.equal(oldReceipt.disposition, 'DONE');
    assert.equal(oldReceipt.verified, true);
    assert.equal(oldReceipt.settlement_commit, firstDone.settlement_commit);

    const secondRun = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'two');
    const secondDone = f.kernel.resolve(secondRun);
    assert.equal(secondDone.disposition, 'DONE');
    assert.equal(secondDone.verified, true);
    assert.equal(f.kernel.inspect()[0].status, 'DONE');

    const graphPatchCommits = execFileSync(
      'git',
      ['-C', f.repo, 'rev-list', '--reverse', 'refs/overcenter/state'],
      { encoding: 'utf8' },
    ).trim().split(/\n+/).filter(Boolean).filter(commit => {
      try {
        execFileSync(
          'git',
          ['-C', f.repo, 'cat-file', '-e', `${commit}:graph-patch.json`],
          { stdio: 'ignore' },
        );
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(graphPatchCommits.length, 2);

    const patches = graphPatchCommits.map(commit=>JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${commit}:graph-patch.json`],
        { encoding: 'utf8' },
      ),
    ) as {
      definitions:Array<{id:string;definition:{packet:unknown}}>;
      bindings:Array<{node_id:string;definition_id:string}>;
    });
    assert.deepEqual(patches[0].definitions[0].definition.packet,{generation:1});
    assert.deepEqual(patches[1].definitions[0].definition.packet,{generation:2});
    assert.notEqual(patches[0].definitions[0].id,patches[1].definitions[0].id);
    assert.equal(patches[0].bindings[0].definition_id,patches[0].definitions[0].id);
    assert.equal(patches[1].bindings[0].definition_id,patches[1].definitions[0].id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('projected terminal receipt remains idempotent after a retry is claimed', () => {
  const f = fixture();
  try {
    const path = f.path('retry-idempotence');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });

    const firstRun = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    const replayable = f.kernel.resolve(firstRun);
    assert.equal(replayable.disposition, 'READY');

    const secondRun = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    const repeated = f.kernel.resolve(firstRun);

    assert.equal(repeated.disposition, 'READY');
    assert.equal(repeated.settlement_commit, replayable.settlement_commit);
    assert.equal(f.kernel.inspect()[0].run_id, secondRun.id);
    assert.equal(f.kernel.inspect()[0].status, 'EXECUTING');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('judgment-required fact projects WAITING without persisting WAITING', () => {
  const f = fixture();
  try {
    const path = f.path('judgment');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });
    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);

    const waiting = f.kernel.deferForJudgment(run, {
      source: 'test',
      question: 'human judgment needed',
    });

    assert.equal(waiting.disposition, 'WAITING');
    assert.equal(waiting.verified, false);
    assert.equal(f.kernel.inspect()[0].status, 'WAITING');

    const persisted = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${waiting.settlement_commit}:receipt.json`],
        { encoding: 'utf8' },
      ),
    ) as Record<string, unknown>;

    assert.equal(persisted.kind, 'judgment-required');
    assert.equal('disposition' in persisted, false);
    assert.equal('verified' in persisted, false);
    assert.equal(JSON.stringify(persisted).includes('WAITING'), false);

    writeFileSync(path, 'present');
    const settled = f.kernel.reconcile(run);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(f.kernel.inspect()[0].status, 'DONE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('kernel explanation surface follows the authoritative projection', () => {
  const f = fixture();
  try {
    const path = f.path('explain');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });

    const ready = f.kernel.explain('x');
    assert.equal(ready.status, 'READY');
    assert.equal(ready.reason.kind, 'claimable');

    const run = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    assert.deepEqual(f.kernel.explain('x'), {
      obligation_id: 'x',
      status: 'EXECUTING',
      reason: {
        kind: 'active-run',
        run_id: run.id,
        semantic_key: run.obligation_key,
        execution_generation: 1,
      },
    });

    f.kernel.recoverInterrupted(run, { source: 'explanation-test' });
    const recovery = f.kernel.explain('x');
    assert.equal(recovery.status, 'RECOVERY_REQUIRED');
    assert.equal(recovery.reason.kind, 'recovery-receipt');

    writeFileSync(path, 'present');
    const reacquired = f.kernel.acquireExecution(run.id);
    f.kernel.reconcile(reacquired);
    const done = f.kernel.explain('x');
    assert.equal(done.status, 'DONE');
    assert.equal(done.reason.kind, 'admissible-realization');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
