import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import { githubCommitStatus } from '../src/providers/github/status-resource.ts';
import { dispatchRegisteredEffect } from '../src/providers/effect-dispatch.ts';

const COMMIT = 'a'.repeat(40);

test('trusted dispatcher infers the registered provider effect from claimed work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let posts = 0;

  try {
    kernel.initialize();
    kernel.define(
      githubCommitStatus.ensure({
        id: 'status-proof',
        target: {
          repository_id: 42,
          repository_full_name: 'acme/widget',
          commit_sha: COMMIT,
          context: 'overcenter/proof',
        },
        desired: { state: 'success' },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    const result = await dispatchRegisteredEffect(kernel, permit, {
      github: {
        token: 'token',
        get: async () => ({
          id: 42,
          node_id: 'R_42',
          full_name: 'acme/widget',
          name: 'widget',
          owner: { login: 'acme' },
        }),
        statusPost: async (_token, path, body) => {
          posts += 1;
          assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
          assert.equal(path, `/repos/acme/widget/statuses/${COMMIT}`);
          assert.equal(body.state, 'success');
          return { status: 201, body: '{}' };
        },
      },
    });

    assert.equal(posts, 1);
    assert.equal(result.state, 'success');
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted dispatcher rejects unregistered effect contracts before reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-unregistered-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    kernel.initialize();
    kernel.define({
      id: 'unknown-effect',
      packet: { effect_contract: 'provider/raw-request' },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: join(root, 'result.txt'),
        content: 'done',
      },
    });
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    await assert.rejects(
      dispatchRegisteredEffect(kernel, permit, { github: { token: 'token' } }),
      /REGISTERED_EFFECT_DISPATCH_UNREGISTERED/,
    );
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
