import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DELEGATION_RESERVATION_SCHEMA,
  DELEGATION_SCHEMA_VERSION,
  RECEIPT_SCHEMA,
} from '../src/authority/facts.ts';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { observePostcondition } from '../src/observation/observe.ts';
import { GitFactStore } from '../src/storage/git-store.ts';
import {
  controlDependency,
  GitKernelFixture,
} from './support/git-kernel-fixture.ts';

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
    const { binding } = await fixture.kernel.performDelegation(spawn, 'child', async () => {
      assert.equal(fixture.kernel.hasUnresolvedDelegation(parent.id), true);
    });

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

test('stale execution generation cannot reserve descendant work', async () => {
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

    await assert.rejects(
      () => fixture.kernel.performDelegation(staleSpawn, 'child', async () => {}),
      /STALE_EXECUTION_GENERATION/,
    );
  } finally {
    fixture.close();
  }
});

test('replay preserves causal multiplicity and reconstructs discharge bindings', async () => {
  const fixture = new GitKernelFixture('overcenter-delegation-replay-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    const spawn = fixture.kernel.authorizeSpawn(parent);
    await fixture.kernel.performDelegation(spawn, 'child', async () => {});
    await fixture.kernel.performDelegation(spawn, 'child', async () => {});

    const freshBefore = fixture.freshKernel().kernel;
    const outstanding = freshBefore.outstandingDelegations(parent.id);
    assert.equal(outstanding.length, 2);
    assert.ok(outstanding.every((delegation) => delegation.run_id === parent.id));
    assert.ok(outstanding.every((delegation) => delegation.child_obligation_id === 'child'));

    fixture.settleFile('child');
    writeSatisfiedParent(fixture, 'parent');

    const recovery = fixture.freshKernel().kernel;
    const [left, right] = recovery.outstandingDelegations(parent.id);
    assert.ok(left);
    assert.ok(right);

    recovery.dischargeDelegation(left);
    assert.equal(recovery.outstandingDelegations(parent.id).length, 1);
    assert.throws(() => fixture.kernel.resolve(parent), /UNRESOLVED_DELEGATION/);

    recovery.dischargeDelegation(right);
    assert.deepEqual(recovery.outstandingDelegations(parent.id), []);

    const settled = fixture.kernel.resolve(parent);
    assert.equal(settled.disposition, 'DONE');

    const reconstructed = fixture.freshKernel().kernel;
    assert.deepEqual(reconstructed.outstandingDelegations(parent.id), []);
  } finally {
    fixture.close();
  }
});

test('dispatch failure leaves durable causal work recoverable', async () => {
  const fixture = new GitKernelFixture('overcenter-delegation-dispatch-failure-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    await assert.rejects(
      () =>
        fixture.kernel.performDelegation(
          fixture.kernel.authorizeSpawn(parent),
          'child',
          async () => {
            throw new Error('TRANSPORT_FAILED_AFTER_RESERVATION');
          },
        ),
      /TRANSPORT_FAILED_AFTER_RESERVATION/,
    );

    const recovered = fixture.freshKernel().kernel.outstandingDelegations(parent.id);
    assert.equal(recovered.length, 1);
    writeSatisfiedParent(fixture, 'parent');
    assert.throws(() => fixture.kernel.resolve(parent), /UNRESOLVED_DELEGATION/);

    fixture.settleFile('child');
    fixture.freshKernel().kernel.dischargeDelegation(recovered[0]);
    assert.equal(fixture.kernel.resolve(parent).disposition, 'DONE');
  } finally {
    fixture.close();
  }
});

test('delegation rejects direct and transitive causal cycles', async () => {
  const fixture = new GitKernelFixture('overcenter-delegation-cycle-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('direct-child', {
      content: 'direct-done',
      dependencies: [controlDependency('parent')],
    });
    fixture.defineFile('middle', {
      content: 'middle-done',
      dependencies: [controlDependency('parent')],
    });
    fixture.defineFile('transitive-child', {
      content: 'transitive-done',
      dependencies: [controlDependency('middle')],
    });

    const parent = fixture.claim('parent');
    const spawn = fixture.kernel.authorizeSpawn(parent);

    await assert.rejects(
      () => fixture.kernel.performDelegation(spawn, 'direct-child', async () => {}),
      /DELEGATION_CAUSAL_CYCLE/,
    );
    await assert.rejects(
      () => fixture.kernel.performDelegation(spawn, 'transitive-child', async () => {}),
      /DELEGATION_CAUSAL_CYCLE/,
    );
    assert.deepEqual(fixture.kernel.outstandingDelegations(parent.id), []);
  } finally {
    fixture.close();
  }
});

test('replay rejects a forged causal-cycle delegation reservation', () => {
  const fixture = new GitKernelFixture('overcenter-delegation-cycle-replay-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', {
      content: 'child-done',
      dependencies: [controlDependency('parent')],
    });
    const parent = fixture.claim('parent');

    const store = new GitFactStore(fixture.authority, { ref: 'refs/overcenter/state' });
    const head = store.head();
    assert.ok(head);
    const forged = store.append(head, 'hostile: causal delegation cycle', {
      'delegation-reservation.json': {
        schema: DELEGATION_RESERVATION_SCHEMA,
        schema_version: DELEGATION_SCHEMA_VERSION,
        delegation_id: 'hostile-cycle',
        run_id: parent.id,
        obligation_id: parent.obligation_id,
        execution_generation: parent.execution_generation,
        execution_authority_commit: parent.execution_authority_commit,
        child_obligation_id: 'child',
      },
    });
    assert.ok(forged);

    assert.throws(() => fixture.kernel.inspect(), /DELEGATION_CAUSAL_CYCLE/);
  } finally {
    fixture.close();
  }
});

test('replay rejects a forged terminal parent receipt with outstanding causal work', async () => {
  const fixture = new GitKernelFixture('overcenter-delegation-hostile-replay-');
  try {
    fixture.defineFile('parent', { content: 'parent-done' });
    fixture.defineFile('child', { content: 'child-done' });

    const parent = fixture.claim('parent');
    await fixture.kernel.performDelegation(
      fixture.kernel.authorizeSpawn(parent),
      'child',
      async () => {},
    );
    writeSatisfiedParent(fixture, 'parent');

    const parentWork = fixture.work('parent');
    const observed = observePostcondition(parentWork.postcondition, { githubToken: null });
    const store = new GitFactStore(fixture.authority, { ref: 'refs/overcenter/state' });
    const head = store.head();
    assert.ok(head);
    const forged = store.append(head, 'hostile: terminal parent before child discharge', {
      'receipt.json': {
        schema: RECEIPT_SCHEMA,
        run_id: parent.id,
        obligation_id: parent.obligation_id,
        claimed_revision: parent.claimed_revision,
        claim_commit: parent.claim_commit,
        execution_generation: parent.execution_generation,
        execution_authority_commit: parent.execution_authority_commit,
        kind: 'observation',
        observed,
        settled_at: '2026-09-23T00:00:00.000Z',
      },
    });
    assert.ok(forged);

    assert.throws(
      () => fixture.kernel.inspect(),
      /TERMINAL_RECEIPT_WITH_UNRESOLVED_DELEGATION/,
    );
  } finally {
    fixture.close();
  }
});

test('SQLite reconstructs outstanding delegation across controller replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-delegation-sqlite-'));
  const database = join(root, 'authority.sqlite');
  const parentPath = join(root, 'parent.txt');
  const childPath = join(root, 'child.txt');
  const first = new OvercenterKernel(database);

  let parentRunId: string | null = null;
  let parentGeneration: number | null = null;

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
    await first.performDelegation(first.authorizeSpawn(parent), 'child', async () => {});
    assert.equal(first.outstandingDelegations(parent.id).length, 1);
  } finally {
    first.close();
  }

  assert.ok(parentRunId);
  assert.ok(parentGeneration !== null);

  const recovery = new OvercenterKernel(database);
  try {
    const [binding] = recovery.outstandingDelegations(parentRunId);
    assert.ok(binding);

    const child = recovery.inspect().find((work) => work.id === 'child');
    assert.ok(child);
    assert.equal(child.status, 'READY');
    const childRun = recovery.claim(child.id, child.revision);
    recovery.beginEffect(childRun);
    writeFileSync(childPath, 'child-done');
    assert.equal(recovery.resolve(childRun).disposition, 'DONE');

    recovery.dischargeDelegation(binding);
    assert.deepEqual(recovery.outstandingDelegations(parentRunId), []);

    const resumedParent = recovery.acquireExecution(parentRunId);
    assert.equal(resumedParent.execution_generation, parentGeneration + 1);
    writeFileSync(parentPath, 'parent-done');
    assert.equal(recovery.resolve(resumedParent).disposition, 'DONE');
  } finally {
    recovery.close();
  }

  const replay = new OvercenterKernel(database);
  try {
    assert.deepEqual(replay.outstandingDelegations(parentRunId), []);
    assert.equal(
      replay.inspect().find((work) => work.id === 'parent')?.status,
      'DONE',
    );
  } finally {
    replay.close();
    rmSync(root, { recursive: true, force: true });
  }
});
