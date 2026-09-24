import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../src/effect-adapter.ts';
import { kubernetesConfigMap } from '../src/providers/kubernetes/configmap-resource.ts';
import { githubCommitStatus } from '../src/providers/github/status-resource.ts';
import { dispatchAdmittedEffect } from '../src/providers/effect-dispatch.ts';

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

    const result = await dispatchAdmittedEffect(kernel, permit, {
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

test('trusted dispatcher admits Kubernetes ConfigMap ensure without kernel special cases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-kubernetes-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-proof',
        target: {
          authority_id: 'kind:production-proof',
          namespace: 'production',
          name: 'api-config',
        },
        desired: { exists: true },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    const result = await dispatchAdmittedEffect(kernel, permit, {
      kubernetes: {
        configMapApply: async (request) => {
          patches += 1;
          assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
          assert.deepEqual(request, {
            authority_id: 'kind:production-proof',
            method: 'PATCH',
            path: '/api/v1/namespaces/production/configmaps/api-config?fieldManager=overcenter',
            content_type: 'application/apply-patch+yaml',
            field_manager: 'overcenter',
            body: {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: {
                namespace: 'production',
                name: 'api-config',
              },
            },
          });
          return { status: 200, body: '{}' };
        },
      },
    });

    assert.equal(patches, 1);
    assert.deepEqual(result, {
      authority_id: 'kind:production-proof',
      namespace: 'production',
      name: 'api-config',
    });
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes mutation failure retains the reservation for observation-driven recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-kubernetes-failure-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-proof',
        target: {
          authority_id: 'kind:production-proof',
          namespace: 'production',
          name: 'api-config',
        },
        desired: { exists: true },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    await assert.rejects(
      dispatchAdmittedEffect(kernel, permit, {
        kubernetes: {
          configMapApply: async () => ({ status: 409, body: 'Conflict' }),
        },
      }),
      /KUBERNETES_CONFIGMAP_MUTATION_FAILED:409:Conflict/,
    );
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
      dispatchAdmittedEffect(kernel, permit, { github: { token: 'token' } }),
      /REGISTERED_EFFECT_DISPATCH_UNREGISTERED/,
    );
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('registered but unadmitted effects cannot enter trusted dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-dispatch-not-admitted-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

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
        expected_previous_head_sha: 'b'.repeat(40),
        base_ref: 'main',
        expected_base_sha: 'c'.repeat(40),
      },
    });
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);

    await assert.rejects(
      dispatchAdmittedEffect(kernel, permit, {}),
      /REGISTERED_EFFECT_DISPATCH_NOT_ADMITTED/,
    );
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
