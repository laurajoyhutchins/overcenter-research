import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_COMMIT_STATUS_EFFECT } from '../src/effect-adapter.ts';
import {
  githubCommitStatus,
  type GithubCommitStatusDesired,
  type GithubCommitStatusTarget,
} from '../src/providers/github/status-resource.ts';
import { performGithubCommitStatusEffect } from '../src/providers/github/status-effect.ts';
import {
  defineSemanticEffect,
  SEMANTIC_EFFECT_INTENT_SCHEMA,
  SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION,
} from '../src/semantic-effect.ts';

const COMMIT = 'a'.repeat(40);
const TARGET: GithubCommitStatusTarget = {
  repository_id: 42,
  repository_full_name: 'acme/widget',
  commit_sha: COMMIT,
  context: 'overcenter/proof',
};
const DESIRED: GithubCommitStatusDesired = { state: 'success' };

test('semantic ensure compiles developer intent into the registered effect contract', () => {
  const obligation = githubCommitStatus.ensure({
    id: 'status-proof',
    target: TARGET,
    desired: DESIRED,
  });

  assert.deepEqual(obligation, {
    id: 'status-proof',
    dependencies: [],
    packet: {
      effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
      semantic_intent: {
        schema: SEMANTIC_EFFECT_INTENT_SCHEMA,
        schema_version: SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION,
        kind: 'ensure',
        resource: 'github.commit-status',
        target: TARGET,
        desired: DESIRED,
      },
    },
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
});

test('adapter declarations cannot override the registry-owned verifier at runtime', () => {
  const unsafe = defineSemanticEffect({
    resource: 'github.commit-status',
    effectContract: GITHUB_COMMIT_STATUS_EFFECT,
    postcondition: () =>
      ({
        verifier: 'file-content-equals/v1',
        provider: 'github',
        repository_id: 42,
        repository_full_name: 'acme/widget',
        commit_sha: COMMIT,
        context: 'overcenter/proof',
        expected_state: 'success',
      }) as never,
  });

  assert.throws(
    () => unsafe.ensure({ id: 'unsafe', target: {}, desired: {} }),
    /SEMANTIC_EFFECT_VERIFIER_IS_REGISTRY_OWNED/,
  );
});

test('semantic ensure drives the existing fenced GitHub mutation path without exposing authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-effect-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let posts = 0;

  try {
    kernel.initialize();
    kernel.define(
      githubCommitStatus.ensure({
        id: 'status-proof',
        target: TARGET,
        desired: DESIRED,
      }),
    );

    const work = kernel.deriveReadyWork();
    assert.ok(work);
    const permit = kernel.claim(work.id, work.revision);

    await performGithubCommitStatusEffect(kernel, permit, {
      token: 'token',
      get: async () => ({
        id: 42,
        node_id: 'R_42',
        full_name: 'acme/widget',
        name: 'widget',
        owner: { login: 'acme' },
      }),
      post: async (_token, path, body) => {
        posts += 1;
        assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
        assert.equal(path, `/repos/acme/widget/statuses/${COMMIT}`);
        assert.equal(body.state, 'success');
        return { status: 201, body: '{}' };
      },
    });

    assert.equal(posts, 1);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
