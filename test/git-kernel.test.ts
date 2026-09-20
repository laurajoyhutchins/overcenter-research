import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
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

test('kernel-owned evidence drives dependency chain to DONE', () => {
  const f = fixture();
  try {
    const a = f.path('a'), b = f.path('b');
    f.kernel.define({ id: 'a', postcondition: pc(a, 'A') });
    f.kernel.define({
      id: 'b',
      dependencies: [{ kind: 'control', upstream: 'a' }],
      postcondition: pc(b, 'B'),
    });

    const first = f.kernel.claim('a', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(a, 'A');
    assert.equal(f.kernel.resolve(first).disposition, 'DONE');

    const second = f.kernel.claim('b', f.kernel.deriveReadyWork()!.revision);
    writeFileSync(b, 'B');
    assert.equal(f.kernel.resolve(second).disposition, 'DONE');

    assert.deepEqual(
      f.kernel.inspect().map(x => [x.id, x.status]),
      [['a', 'DONE'], ['b', 'DONE']],
    );
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

    assert.throws(() => f.kernel.resolve(first), /STALE_EXECUTION_GENERATION/);

    const replayable = f.kernel.resolve(second);
    assert.equal(replayable.disposition, 'READY');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('session-bound execution acquisition rejects a stale generation', () => {
  const f = fixture();
  try {
    const path = f.path('session-generation-fence');
    f.kernel.define({ id: 'x', postcondition: pc(path, 'present') });
    const first = f.kernel.claim('x', f.kernel.deriveReadyWork()!.revision);
    const second = f.kernel.acquireExecution(first.id, { expectedGeneration: 1 });

    assert.equal(second.execution_generation, 2);
    assert.throws(
      () => f.kernel.acquireExecution(first.id, { expectedGeneration: 1 }),
      /STALE_EXECUTION_SESSION/,
    );

    const third = f.kernel.acquireExecution(first.id, { expectedGeneration: 2 });
    assert.equal(third.execution_generation, 3);
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

test('historical receipt stays bound to the obligation generation claimed by its run', () => {
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

    const beforeAmend = f.kernel.head()!;
    f.kernel.amend({
      id: 'x',
      packet: { generation: 2 },
      postcondition: pc(path, 'two'),
    }, beforeAmend);

    const amended = f.kernel.inspect()[0];
    assert.equal(amended.status, 'READY');
    assert.deepEqual(amended.packet, { generation: 2 });
    assert.deepEqual(amended.postcondition, pc(path, 'two'));

    // This is the hostile historical-binding assertion. The old observation
    // matches generation 1 and does not match generation 2.
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

    const definitionCommits = execFileSync(
      'git',
      ['-C', f.repo, 'rev-list', '--reverse', 'refs/overcenter/state'],
      { encoding: 'utf8' },
    ).trim().split(/\n+/).filter(Boolean).filter(commit => {
      try {
        execFileSync(
          'git',
          ['-C', f.repo, 'cat-file', '-e', `${commit}:obligation.json`],
          { stdio: 'ignore' },
        );
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(definitionCommits.length, 2);

    const amendedFact = JSON.parse(
      execFileSync(
        'git',
        ['-C', f.repo, 'show', `${definitionCommits[1]}:obligation.json`],
        { encoding: 'utf8' },
      ),
    ) as {
      kind: string;
      previous_definition_commit?: string;
      obligation: { packet: unknown };
    };
    assert.equal(amendedFact.kind, 'amended');
    assert.equal(amendedFact.previous_definition_commit, definitionCommits[0]);
    assert.deepEqual(amendedFact.obligation.packet, { generation: 2 });
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
