import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KernelCore, type EffectAuthority } from '../src/authority/engine.ts';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_COMMIT_STATUS_EFFECT } from '../src/effect-adapter.ts';

const COMMIT = 'a'.repeat(40);

function define(kernel: OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id: 'status-proof',
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: 'overcenter/proof',
      expected_state: 'success',
    },
  });
  const work = kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(work.id, work.revision);
}

test('effect reservation is not a public KernelCore API', () => {
  assert.equal('beginEffect' in KernelCore.prototype, false);
});

test('structurally forged effect authority is rejected before reservation or callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-authority-forged-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let invoked = 0;
  try {
    const permit = define(kernel);
    const forged = {
      postcondition: kernel.claimedWork(permit).postcondition,
    } as unknown as EffectAuthority<typeof GITHUB_COMMIT_STATUS_EFFECT, 'github-commit-status/v2'>;

    assert.throws(
      () =>
        kernel.performEffect(forged, () => {
          invoked += 1;
        }),
      /EFFECT_AUTHORITY_INVALID/,
    );
    assert.equal(invoked, 0);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('minting rejects stale execution and reservation rechecks authority immediately before mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-authority-stale-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let invoked = 0;
  try {
    const generationOne = define(kernel);
    const generationTwo = kernel.acquireExecution(generationOne.id);

    assert.throws(
      () => kernel.authorizeEffect(generationOne, GITHUB_COMMIT_STATUS_EFFECT),
      /STALE_EXECUTION_GENERATION/,
    );

    const authority = kernel.authorizeEffect(generationTwo, GITHUB_COMMIT_STATUS_EFFECT);
    const generationThree = kernel.acquireExecution(generationTwo.id);
    assert.equal(generationThree.execution_generation, generationTwo.execution_generation + 1);

    assert.throws(
      () =>
        kernel.performEffect(authority, () => {
          invoked += 1;
        }),
      /STALE_EXECUTION_GENERATION/,
    );
    assert.equal(invoked, 0);
    assert.equal(kernel.hasUnresolvedEffect(generationTwo.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
