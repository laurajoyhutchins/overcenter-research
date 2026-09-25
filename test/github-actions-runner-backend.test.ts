import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  GithubActionsRunnerBackend,
  type GithubJitRunnerPost,
} from '../src/providers/github/actions-runner-backend.ts';

class MemoryStore {
  #head: string | null = null;
  #value: unknown = null;
  #sequence = 0;

  head(): string | null {
    return this.#head;
  }

  read(head: string): unknown | null {
    assert.equal(head, this.#head);
    return structuredClone(this.#value);
  }

  append(expectedHead: string | null, value: unknown): string | null {
    if (expectedHead !== this.#head) return null;
    this.#sequence += 1;
    this.#head = `authority-${this.#sequence}`;
    this.#value = structuredClone(value);
    return this.#head;
  }

  value(): unknown {
    return structuredClone(this.#value);
  }
}

function repository(id = 42) {
  return {
    id,
    node_id: `R_${id}`,
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function connectionName(leaseId: string): string {
  return `overcenter-${createHash('sha256').update(leaseId).digest('hex').slice(0, 24)}`;
}

test('runner backend durably fences one JIT configuration and keeps the secret ephemeral', async () => {
  const store = new MemoryStore();
  const backend = new GithubActionsRunnerBackend('.', { store });
  let posts = 0;

  const connection = await backend.mintJitConnection('token', {
    leaseId: 'sandbox-slot-1',
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    runnerGroupId: 7,
    get: async (_token, path) => {
      assert.equal(path, '/repos/acme/widget');
      return repository();
    },
    post: async (_token, path, body) => {
      posts += 1;
      assert.equal(
        (store.value() as { registrations: Array<{ phase: string }> }).registrations[0]?.phase,
        'dispatching',
        'durable dispatch state must exist before provider mutation',
      );
      assert.equal(path, '/repos/acme/widget/actions/runners/generate-jitconfig');
      assert.deepEqual(body, {
        name: connectionName('sandbox-slot-1'),
        runner_group_id: 7,
        labels: ['overcenter', 'self-hosted'],
        work_folder: '_work',
      });
      return {
        status: 201,
        body: JSON.stringify({
          runner: { id: 91, name: connectionName('sandbox-slot-1') },
          encoded_jit_config: 'secret-jit-config',
        }),
      };
    },
  });

  assert.equal(posts, 1);
  assert.equal(connection.runner_id, 91);
  assert.equal(connection.runner_name, connectionName('sandbox-slot-1'));
  assert.equal(connection.encoded_jit_config, 'secret-jit-config');
  assert.match(connection.encoded_jit_config_sha256, /^[0-9a-f]{64}$/);

  const durable = JSON.stringify(store.value());
  assert.doesNotMatch(durable, /secret-jit-config/);
  assert.match(durable, new RegExp(connection.encoded_jit_config_sha256));
  assert.match(durable, /"phase":"registered"/);

  const observed = backend.connectionState('sandbox-slot-1');
  assert.equal(observed?.phase, 'registered');
  if (observed?.phase === 'registered') {
    assert.equal(observed.runner_id, 91);
    assert.equal(observed.encoded_jit_config_sha256, connection.encoded_jit_config_sha256);
  }

  await assert.rejects(
    backend.mintJitConnection('token', {
      leaseId: 'sandbox-slot-1',
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
      runnerGroupId: 7,
      get: async () => repository(),
      post: async () => {
        posts += 1;
        return { status: 500, body: 'must not run' };
      },
    }),
    /GITHUB_ACTIONS_RUNNER_CONFIG_ALREADY_MINTED/,
  );
  assert.equal(posts, 1);
});

test('ambiguous JIT dispatch fails closed and cannot mint a second runner', async () => {
  const store = new MemoryStore();
  const backend = new GithubActionsRunnerBackend('.', { store });
  let posts = 0;
  const post: GithubJitRunnerPost = async () => {
    posts += 1;
    throw new Error('ECONNRESET');
  };

  await assert.rejects(
    backend.mintJitConnection('token', {
      leaseId: 'sandbox-slot-2',
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
      runnerGroupId: 7,
      get: async () => repository(),
      post,
    }),
    /ECONNRESET/,
  );
  assert.equal(posts, 1);
  assert.equal(backend.connectionState('sandbox-slot-2')?.phase, 'dispatching');

  await assert.rejects(
    backend.mintJitConnection('token', {
      leaseId: 'sandbox-slot-2',
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
      runnerGroupId: 7,
      get: async () => {
        throw new Error('provider read must not repeat');
      },
      post,
    }),
    /GITHUB_ACTIONS_RUNNER_REGISTRATION_RECOVERY_REQUIRED/,
  );
  assert.equal(posts, 1);
});

test('repository identity drift fails before durable runner dispatch', async () => {
  const store = new MemoryStore();
  const backend = new GithubActionsRunnerBackend('.', { store });
  let posts = 0;

  await assert.rejects(
    backend.mintJitConnection('token', {
      leaseId: 'sandbox-slot-3',
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
      runnerGroupId: 7,
      get: async () => repository(43),
      post: async () => {
        posts += 1;
        return { status: 201, body: '{}' };
      },
    }),
    /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
  );
  assert.equal(posts, 0);
  assert.equal(store.head(), null);
});

test('different leases can register independently through one durable backend', async () => {
  const store = new MemoryStore();
  const backend = new GithubActionsRunnerBackend('.', { store });
  let nextRunnerId = 100;

  for (const leaseId of ['slot-a', 'slot-b']) {
    const connection = await backend.mintJitConnection('token', {
      leaseId,
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
      runnerGroupId: 7,
      get: async () => repository(),
      post: async (_token, _path, body) => ({
        status: 201,
        body: JSON.stringify({
          runner: { id: nextRunnerId++, name: body.name },
          encoded_jit_config: `config-${leaseId}`,
        }),
      }),
    });
    assert.equal(connection.runner_name, connectionName(leaseId));
  }

  const durable = store.value() as { registrations: Array<{ phase: string }> };
  assert.equal(durable.registrations.length, 2);
  assert.deepEqual(
    durable.registrations.map((registration) => registration.phase),
    ['registered', 'registered'],
  );
});
