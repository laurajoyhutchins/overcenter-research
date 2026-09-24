import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type Server } from 'node:net';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import {
  createGithubStatusPost,
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
  type GithubStatusPost,
} from '../src/providers/github/status-effect.ts';
import { GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED } from '../src/effect-adapter.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';

const COMMIT = 'a'.repeat(40);

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('INVALID_LISTEN_ADDRESS');
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

function status() {
  return {
    id: 7,
    node_id: 'STATUS_7',
    state: 'success',
    context: 'overcenter/proof',
    target_url: null,
    created_at: '2026-09-20T20:00:00Z',
    updated_at: '2026-09-20T20:00:01Z',
  };
}

function define(kernel: OvercenterKernel, effectContract: unknown = GITHUB_COMMIT_STATUS_EFFECT) {
  kernel.initialize();
  kernel.define({
    id: 'status-proof',
    packet: { effect_contract: effectContract },
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

test('production GitHub status effect derives provider coordinates from authority and reserves before POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-effect-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  const calls: Array<{ kind: 'get' | 'post'; path: string; body?: unknown }> = [];
  const get = async (_token: string, path: string) => {
    calls.push({ kind: 'get', path });
    assert.equal(path, '/repos/acme/widget');
    await Promise.resolve();
    return repository();
  };
  try {
    const run = define(kernel);
    const post: GithubStatusPost = async (_token, path, body) => {
      calls.push({ kind: 'post', path, body });
      assert.equal(kernel.hasUnresolvedEffect(run.id), true);
      return { status: 201, body: '{}' };
    };
    const result = await performGithubCommitStatusEffect(kernel, run, {
      token: 'token',
      get,
      post,
      clock: () => '2026-09-20T20:00:00.000Z',
    });

    assert.deepEqual(result, {
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: 'overcenter/proof',
      state: 'success',
    });
    assert.deepEqual(calls, [
      { kind: 'get', path: '/repos/acme/widget' },
      {
        kind: 'post',
        path: `/repos/acme/widget/statuses/${COMMIT}`,
        body: {
          state: 'success',
          context: 'overcenter/proof',
          description: 'Overcenter trusted effect broker',
        },
      },
    ]);
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository identity mismatch fails before reservation or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-identity-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let posts = 0;

  try {
    const run = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => repository(43),
        post: async () => {
          posts += 1;
          return { status: 201, body: '{}' };
        },
      }),
      /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
    );
    assert.equal(posts, 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing effect grant fails before provider I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-grant-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let reads = 0;
  let posts = 0;

  try {
    const run = define(kernel, 'other-effect');
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => {
          reads += 1;
          return repository();
        },
        post: async () => {
          posts += 1;
          return { status: 201, body: '{}' };
        },
      }),
      /EFFECT_CONTRACT_NOT_AUTHORIZED/,
    );
    assert.equal(reads, 0);
    assert.equal(posts, 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('lost broker acknowledgement survives SQLite reopen and settles from authoritative GitHub readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-recovery-'));
  const database = join(root, 'overcenter.sqlite');
  const first = new OvercenterKernel(database);
  let providerState: 'missing' | 'success' = 'missing';

  try {
    const run = define(first);
    await performGithubCommitStatusEffect(first, run, {
      token: 'token',
      get: () => repository(),
      post: async () => {
        providerState = 'success';
        return { status: 201, body: '{}' };
      },
    });
    assert.equal(first.hasUnresolvedEffect(run.id), true);
    first.close();

    const get: GithubJsonGet = (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      if (path === `/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
        const statuses = providerState === 'success' ? [status()] : [];
        return {
          state: providerState === 'success' ? 'success' : 'pending',
          sha: COMMIT,
          total_count: statuses.length,
          repository: repository(),
          statuses,
        };
      }
      assert.match(
        path,
        new RegExp(`^/repos/acme/widget/commits/${COMMIT}/statuses\\?page=1&per_page=30$`),
      );
      return providerState === 'success' ? [status()] : [];
    };
    const fresh = new OvercenterKernel(database, {
      githubToken: 'token',
      observationContext: { githubGet: get },
    });
    try {
      const recoveryPermit = fresh.acquireExecution(run.id);
      assert.equal(recoveryPermit.execution_generation, 2);
      const interrupted = fresh.recoverInterrupted(recoveryPermit, { source: 'broker-supervisor' });
      assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
      const settled = fresh.reconcile(recoveryPermit);
      assert.equal(settled.disposition, 'DONE');
      assert.equal(settled.verified, true);
      assert.equal(fresh.inspect()[0].status, 'DONE');
      assert.deepEqual(
        fresh.receipts(run.id).map((receipt) => receipt.disposition),
        ['RECOVERY_REQUIRED', 'DONE'],
      );
    } finally {
      fresh.close();
    }
  } finally {
    try {
      first.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh canonical GitHub HTTPS failure before secureConnect releases only the exact reservation and requires a new run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-not-dispatched-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let lookedUpHost = '';

  try {
    const first = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, first, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          lookup: (hostname, _options, callback) => {
            lookedUpHost = hostname;
            callback(null, '127.0.0.2', 4);
          },
        }),
      }),
      /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
    );

    assert.equal(lookedUpHost, 'api.github.com');
    assert.equal(kernel.hasUnresolvedEffect(first.id), false);
    assert.equal(kernel.inspect()[0]?.status, 'READY');

    const receipts = kernel.receipts(first.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.kind, 'effect-not-dispatched');
    assert.equal(receipts[0]?.disposition, 'READY');

    const reopened = new OvercenterKernel(join(root, 'overcenter.sqlite'));
    try {
      assert.equal(reopened.hasUnresolvedEffect(first.id), false);
      assert.equal(reopened.inspect()[0]?.status, 'READY');
      assert.equal(reopened.receipts(first.id)[0]?.kind, 'effect-not-dispatched');
    } finally {
      reopened.close();
    }

    const retryWork = kernel.deriveReadyWork();
    assert.ok(retryWork);
    const second = kernel.claim(retryWork.id, retryWork.revision);
    assert.notEqual(second.id, first.id);
    assert.equal(second.execution_generation, 1);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('transport-minted NOT_DISPATCHED witness from a non-GitHub origin cannot release the reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-wrong-origin-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let peerTlsBytes = 0;
  const reset = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      peerTlsBytes += chunk.length;
      socket.destroy();
    });
  });
  const port = await listen(reset);

  try {
    const run = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          baseUrl: `https://127.0.0.1:${port}`,
          rejectUnauthorized: false,
        }),
      }),
      /EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED/,
    );

    assert.ok(peerTlsBytes > 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    assert.equal(kernel.inspect()[0]?.status, 'EXECUTING');
  } finally {
    await closeServer(reset);
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertReservationRemainsUnresolved(
  post: GithubStatusPost,
  expectedError: RegExp,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'github-status-uncertain-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    const run = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => repository(),
        post,
      }),
      expectedError,
    );

    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    const interrupted = kernel.recoverInterrupted(run, { source: 'production-regression' });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
    assert.equal(kernel.inspect()[0]?.status, 'RECOVERY_REQUIRED');
    assert.equal(kernel.deriveReadyWork(), null);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('post-dispatch transport uncertainty keeps the GitHub status reservation unresolved', async () => {
  await assertReservationRemainsUnresolved(async () => {
    throw new Error('GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:ECONNRESET');
  }, /GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN/);
});

test('HTTP 502 keeps the GitHub status reservation unresolved', async () => {
  await assertReservationRemainsUnresolved(
    async () => ({ status: 502, body: 'bad gateway' }),
    /GITHUB_STATUS_MUTATION_FAILED:502/,
  );
});

test('the admitted NOT_DISPATCHED token cannot release a reservation without a transport-minted witness', () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-witness-forgery-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    const run = define(kernel);
    const authority = kernel.authorizeEffect(run, GITHUB_COMMIT_STATUS_EFFECT);
    kernel.beginEffect(run);

    assert.throws(
      () =>
        kernel.releaseEffectReservation(
          authority,
          GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED as never,
        ),
      /EFFECT_RELEASE_EVIDENCE_PROVENANCE_INVALID/,
    );
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    assert.equal(kernel.inspect()[0]?.status, 'EXECUTING');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
