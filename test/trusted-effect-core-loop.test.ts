import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type Server } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { OvercenterKernel, runCoreLoop } from '../src/authority/kernel.ts';
import { githubCommitStatus } from '../src/providers/github/status-resource.ts';
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

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function status(context = 'overcenter/proof') {
  return {
    id: 7,
    node_id: 'STATUS_7',
    state: 'success',
    context,
    target_url: null,
    created_at: '2026-09-23T20:00:00Z',
    updated_at: '2026-09-23T20:00:01Z',
  };
}

function githubRead(providerState: () => 'missing' | 'success'): GithubJsonGet {
  return (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    if (path === `/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
      const statuses = providerState() === 'success' ? [status()] : [];
      return {
        state: providerState() === 'success' ? 'success' : 'pending',
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
    return providerState() === 'success' ? [status()] : [];
  };
}

function defineStatus(kernel: OvercenterKernel): void {
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
}

function reservationCount(database: string): number {
  const db = new DatabaseSync(database);
  try {
    const rows = db.prepare('SELECT files_json FROM fact_commits').all() as Array<{
      files_json: string;
    }>;
    return rows.filter((row) =>
      Object.hasOwn(JSON.parse(row.files_json), 'effect-reservation.json'),
    ).length;
  } finally {
    db.close();
  }
}

test('core loop dispatches an admitted effect with exactly one reservation owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-'));
  const database = join(root, 'overcenter.sqlite');
  let providerState: 'missing' | 'success' = 'missing';
  const read = githubRead(() => providerState);
  const kernel = new OvercenterKernel(database, {
    githubToken: 'token',
    observationContext: { githubGet: read },
  });
  let posts = 0;

  try {
    defineStatus(kernel);

    const result = await runCoreLoop(kernel, {
      trustedEffects: {
        github: {
          token: 'token',
          get: async (token, path) => read(token, path),
          statusPost: async () => {
            posts += 1;
            const running = kernel.inspect().find((work) => work.id === 'status-proof');
            assert.ok(running?.run_id);
            assert.equal(kernel.hasUnresolvedEffect(running.run_id), true);
            providerState = 'success';
            return { status: 201, body: '{}' };
          },
        },
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(posts, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
    assert.equal(kernel.receipts().at(-1)?.verified, true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('admitted effect uncertainty remains recovery-required through the core loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-uncertain-'));
  const database = join(root, 'overcenter.sqlite');
  let providerState: 'missing' | 'success' = 'missing';
  const read = githubRead(() => providerState);
  const kernel = new OvercenterKernel(database, {
    githubToken: 'token',
    observationContext: { githubGet: read },
  });
  let posts = 0;

  try {
    defineStatus(kernel);

    const result = await runCoreLoop(kernel, {
      trustedEffects: {
        github: {
          token: 'token',
          get: async (token, path) => read(token, path),
          statusPost: async () => {
            posts += 1;
            const running = kernel.inspect().find((work) => work.id === 'status-proof');
            assert.ok(running?.run_id);
            assert.equal(kernel.hasUnresolvedEffect(running.run_id), true);
            throw new Error('GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:ECONNRESET');
          },
        },
      },
    });

    assert.equal(result.state, 'RECOVERY_REQUIRED');
    assert.equal(posts, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'RECOVERY_REQUIRED');
    assert.equal(kernel.hasUnresolvedEffect(result.run!), true);
    const receipt = kernel.receipts(result.run!).at(-1);
    const diagnosticOutcome = receipt?.diagnostic?.outcome as Record<string, unknown> | undefined;
    assert.equal(diagnosticOutcome?.kind, 'execution-error');
    assert.equal(diagnosticOutcome?.may_have_mutated, true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted NOT_DISPATCHED release remains READY through the core loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-not-dispatched-'));
  const database = join(root, 'overcenter.sqlite');
  const read = githubRead(() => 'missing');
  const kernel = new OvercenterKernel(database, {
    githubToken: 'token',
    observationContext: { githubGet: read },
  });
  const reset = createTcpServer((socket) => {
    socket.once('data', () => socket.destroy());
  });
  const port = await listen(reset);

  try {
    defineStatus(kernel);

    const result = await runCoreLoop(kernel, {
      maxAdvances: 1,
      trustedEffects: {
        github: {
          token: 'token',
          get: async (token, path) => read(token, path),
          transport: {
            baseUrl: `https://127.0.0.1:${port}`,
            rejectUnauthorized: false,
          },
        },
      },
    });

    assert.equal(result.state, 'BUDGET_EXHAUSTED');
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'READY');
    const receipt = kernel.receipts().at(-1);
    assert.equal(receipt?.kind, 'effect-not-dispatched');
    assert.equal(receipt?.disposition, 'READY');
    assert.equal(kernel.hasUnresolvedEffect(receipt!.run_id), false);
  } finally {
    await close(reset);
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-reservation trusted dispatch failure is surfaced instead of silently retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-pre-reservation-error-'));
  const database = join(root, 'overcenter.sqlite');
  const authoritativeRead = githubRead(() => 'missing');
  const kernel = new OvercenterKernel(database, {
    githubToken: 'token',
    observationContext: { githubGet: authoritativeRead },
  });
  let posts = 0;

  try {
    defineStatus(kernel);

    await assert.rejects(
      runCoreLoop(kernel, {
        trustedEffects: {
          github: {
            token: 'token',
            get: async () => ({
              id: 43,
              node_id: 'R_43',
              full_name: 'acme/widget',
              name: 'widget',
              owner: { login: 'acme' },
            }),
            statusPost: async () => {
              posts += 1;
              return { status: 201, body: '{}' };
            },
          },
        },
      }),
      /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
    );

    assert.equal(posts, 0);
    assert.equal(reservationCount(database), 0);
    assert.notEqual(kernel.inspect()[0]?.status, 'DONE');
    const receipt = kernel.receipts().at(-1);
    assert.equal(receipt?.kind, 'observation');
    assert.notEqual(receipt?.disposition, 'DONE');
    const diagnosticOutcome = receipt?.diagnostic?.outcome as Record<string, unknown> | undefined;
    assert.equal(diagnosticOutcome?.kind, 'execution-error');
    assert.equal(diagnosticOutcome?.may_have_mutated, false);
    assert.match(String(diagnosticOutcome?.error), /GITHUB_REPOSITORY_IDENTITY_MISMATCH/);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('undefined trusted effect mode is rejected before claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-invalid-mode-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    kernel.initialize();
    kernel.define({
      id: 'x',
      packet: {},
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: join(root, 'x'),
        content: 'x',
      },
    });
    const before = kernel.head();

    await assert.rejects(
      runCoreLoop(kernel, {
        trustedEffects: undefined,
      } as never),
      /INVALID_EFFECT_EXECUTION_MODE/,
    );

    assert.equal(kernel.head(), before);
    assert.equal(kernel.inspect()[0]?.status, 'READY');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('admitted effects preserve bounded concurrency and one reservation per run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-concurrency-'));
  const database = join(root, 'overcenter.sqlite');
  const commits = ['b'.repeat(40), 'c'.repeat(40)] as const;
  const contexts = new Map([
    [commits[0], 'overcenter/a'],
    [commits[1], 'overcenter/b'],
  ]);
  const successful = new Set<string>();
  const read: GithubJsonGet = (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    for (const commit of commits) {
      const observedStatuses = successful.has(commit) ? [status(contexts.get(commit)!)] : [];
      if (path === `/repos/acme/widget/commits/${commit}/status?page=1&per_page=100`) {
        return {
          state: successful.has(commit) ? 'success' : 'pending',
          sha: commit,
          total_count: observedStatuses.length,
          repository: repository(),
          statuses: observedStatuses,
        };
      }
      if (path === `/repos/acme/widget/commits/${commit}/statuses?page=1&per_page=30`) {
        return observedStatuses;
      }
    }
    throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
  };
  const kernel = new OvercenterKernel(database, {
    githubToken: 'token',
    observationContext: { githubGet: read },
  });
  let active = 0;
  let maxActive = 0;
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('TRUSTED_EFFECT_CONCURRENCY_NOT_OBSERVED')),
      1_000,
    );
    releaseBoth = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  try {
    kernel.initialize();
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index]!;
      kernel.define(
        githubCommitStatus.ensure({
          id: `status-${index}`,
          target: {
            repository_id: 42,
            repository_full_name: 'acme/widget',
            commit_sha: commit,
            context: contexts.get(commit)!,
          },
          desired: { state: 'success' },
        }),
      );
    }

    const result = await runCoreLoop(kernel, {
      concurrency: 2,
      trustedEffects: {
        github: {
          token: 'token',
          get: async (token, path) => read(token, path),
          statusPost: async (_token, path, body) => {
            const match = path.match(/\/statuses\/([0-9a-f]{40})$/);
            assert.ok(match);
            const commit = match[1]!;
            assert.equal(body.context, contexts.get(commit));
            active += 1;
            maxActive = Math.max(maxActive, active);
            if (active === 2) releaseBoth();
            await bothStarted;
            successful.add(commit);
            active -= 1;
            return { status: 201, body: '{}' };
          },
        },
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(maxActive, 2);
    assert.equal(reservationCount(database), 2);
    assert.ok(kernel.inspect().every((work) => work.status === 'DONE'));
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('observation failure cannot mask a pre-reservation broker failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trusted-effect-loop-observation-mask-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    githubToken: 'token',
    observationContext: {
      githubGet: () => {
        throw new Error('OBSERVATION_DOWN');
      },
    },
  });

  try {
    defineStatus(kernel);

    await assert.rejects(
      runCoreLoop(kernel, {
        trustedEffects: {
          github: {
            token: 'token',
            get: async () => ({
              id: 43,
              node_id: 'R_43',
              full_name: 'acme/widget',
              name: 'widget',
              owner: { login: 'acme' },
            }),
          },
        },
      }),
      /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
    );

    assert.equal(reservationCount(join(root, 'overcenter.sqlite')), 0);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
