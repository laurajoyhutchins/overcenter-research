import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DelegationAttemptBinding } from '../src/authority/engine.ts';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GitKernelFixture } from './support/git-kernel-fixture.ts';

function writeSatisfiedParent(fixture: GitKernelFixture, id: string): void {
  const work = fixture.work(id);
  if (work.postcondition.verifier !== 'file-content-equals/v1') {
    throw new Error('TEST_PARENT_POSTCONDITION_UNSUPPORTED');
  }
  writeFileSync(work.postcondition.path, work.postcondition.content);
}

test('delegation is durable before dispatch and blocks terminal parent settlement', async () => {
  const fixture = new GitKernelFixture('overcenter-delegation-accounting-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    const spawn = fixture.kernel.authorizeSpawn(parent);
    let binding: DelegationAttemptBinding | null = null;

    await fixture.kernel.performDelegation(spawn, 'child', async (attempt) => {
      binding = attempt;
      assert.equal(fixture.kernel.hasUnresolvedDelegation(parent.id), true);
    });
    assert.ok(binding);

    writeSatisfiedParent(fixture, 'parent');
    assert.throws(() => fixture.kernel.resolve(parent), /UNRESOLVED_DELEGATION/);

    fixture.settleFile('child');
    const discharge = fixture.kernel.dischargeDelegation(binding);
    assert.equal(fixture.kernel.dischargeDelegation(binding), discharge);
    assert.equal(fixture.kernel.hasUnresolvedDelegation(parent.id), false);

    const settled = fixture.kernel.resolve(parent);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
  } finally {
    fixture.close();
  }
});

test('stale execution generation cannot reserve descendant work', () => {
  const fixture = new GitKernelFixture('overcenter-delegation-stale-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    const staleSpawn = fixture.kernel.authorizeSpawn(parent);
    const interrupted = fixture.kernel.recoverInterrupted(parent, {
      source: 'delegation-stale-generation-test',
    });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
    const successor = fixture.kernel.acquireExecution(parent.id);
    assert.equal(successor.execution_generation, parent.execution_generation + 1);

    assert.throws(
      () => fixture.kernel.reserveDelegation(staleSpawn, 'child'),
      /STALE_EXECUTION_GENERATION/,
    );
  } finally {
    fixture.close();
  }
});

test('replay preserves causal multiplicity and a fresh controller can discharge it', () => {
  const fixture = new GitKernelFixture('overcenter-delegation-replay-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    const spawn = fixture.kernel.authorizeSpawn(parent);
    const left = fixture.kernel.reserveDelegation(spawn, 'child');
    const right = fixture.kernel.reserveDelegation(spawn, 'child');

    const freshBefore = fixture.freshKernel().kernel;
    assert.equal(freshBefore.hasUnresolvedDelegation(parent.id), true);

    fixture.settleFile('child');
    writeSatisfiedParent(fixture, 'parent');

    const recovery = fixture.freshKernel().kernel;
    recovery.dischargeDelegation(left);
    assert.equal(recovery.hasUnresolvedDelegation(parent.id), true);
    assert.throws(() => fixture.kernel.resolve(parent), /UNRESOLVED_DELEGATION/);

    recovery.dischargeDelegation(right);
    assert.equal(recovery.hasUnresolvedDelegation(parent.id), false);

    const settled = fixture.kernel.resolve(parent);
    assert.equal(settled.disposition, 'DONE');

    const reconstructed = fixture.freshKernel().kernel;
    assert.equal(reconstructed.hasUnresolvedDelegation(parent.id), false);
  } finally {
    fixture.close();
  }
});


test('SQLite reconstructs outstanding delegation across controller replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-delegation-sqlite-'));
  const database = join(root, 'authority.sqlite');
  const parentPath = join(root, 'parent.txt');
  const childPath = join(root, 'child.txt');
  const first = new OvercenterKernel(database);

  let binding: DelegationAttemptBinding;
  let parentRunId: string;
  let parentGeneration: number;

  try {
    first.initialize();
    first.define({
      id: 'parent',
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: parentPath,
        content: 'parent-done',
      },
    });
    first.define({
      id: 'child',
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: childPath,
        content: 'child-done',
      },
    });

    const parentWork = first.inspect().find((work) => work.id === 'parent');
    assert.ok(parentWork);
    const parent = first.claim('parent', parentWork.revision);
    parentRunId = parent.id;
    parentGeneration = parent.execution_generation;
    binding = first.reserveDelegation(first.authorizeSpawn(parent), 'child');
    assert.equal(first.hasUnresolvedDelegation(parent.id), true);
  } finally {
    first.close();
  }

  const recovery = new OvercenterKernel(database);
  try {
    assert.equal(recovery.hasUnresolvedDelegation(parentRunId), true);

    const child = recovery.inspect().find((work) => work.id === 'child');
    assert.ok(child);
    assert.equal(child.status, 'READY');
    const childRun = recovery.claim(child.id, child.revision);
    recovery.beginEffect(childRun);
    writeFileSync(childPath, 'child-done');
    assert.equal(recovery.resolve(childRun).disposition, 'DONE');

    recovery.dischargeDelegation(binding);
    assert.equal(recovery.hasUnresolvedDelegation(parentRunId), false);

    const resumedParent = recovery.acquireExecution(parentRunId);
    assert.equal(resumedParent.execution_generation, parentGeneration + 1);
    writeFileSync(parentPath, 'parent-done');
    assert.equal(recovery.resolve(resumedParent).disposition, 'DONE');
  } finally {
    recovery.close();
  }

  const replay = new OvercenterKernel(database);
  try {
    assert.equal(replay.hasUnresolvedDelegation(parentRunId), false);
    assert.equal(
      replay.inspect().find((work) => work.id === 'parent')?.status,
      'DONE',
    );
  } finally {
    replay.close();
    rmSync(root, { recursive: true, force: true });
  }
});
