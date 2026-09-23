import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../src/effect-adapter.ts';
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


test('trusted dispatcher routes the registered PR update effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-pr-update-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  const head = 'b'.repeat(40);
  const base = 'c'.repeat(40);
  let puts = 0;

  try {
    kernel.initialize();
    kernel.define({
      id: 'refresh-pr',
      packet: { effect_contract: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT },
      postcondition: {
        verifier: 'github-pull-request-branch-updated/v1',
        provider: 'github',
        repository_id: 42,
        repository_full_name: 'acme/widget',
        pull_number: 37,
        pull_node_id: 'PR_node_37',
        expected_previous_head_sha: head,
        base_ref: 'main',
        expected_base_sha: base,
      },
    });
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    const result = await dispatchRegisteredEffect(kernel, permit, {
      github: {
        token: 'token',
        get: async (_token, path) => {
          if (path === '/repos/acme/widget') {
            return {
              id: 42,
              node_id: 'R_42',
              full_name: 'acme/widget',
              name: 'widget',
              owner: { login: 'acme' },
            };
          }
          if (path === '/repos/acme/widget/pulls/37') {
            return {
              id: 3700,
              node_id: 'PR_node_37',
              number: 37,
              state: 'open',
              head: { sha: head },
              base: { ref: 'main', sha: base },
            };
          }
          throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
        },
        updateBranchPut: async (_token, path, body) => {
          puts += 1;
          assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
          assert.equal(path, '/repos/acme/widget/pulls/37/update-branch');
          assert.equal(body.expected_head_sha, head);
          return { status: 202, body: '{}' };
        },
      },
    });

    assert.equal(puts, 1);
    assert.equal(result.previous_head_sha, head);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
