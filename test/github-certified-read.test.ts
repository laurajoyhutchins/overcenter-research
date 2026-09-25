import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCertifiedGithubSemanticRead } from '../src/providers/github/certified-read.ts';
import {
  observeGithubAccountRepositories,
  observeGithubActionsLoad,
  projectGithubActionsCapacity,
  type GithubActionsLoadObservation,
} from '../src/providers/github/actions-capacity.ts';
import {
  GithubActionsCapacityController,
  type GithubActionsReservationStore,
} from '../src/providers/github/actions-capacity-controller.ts';

const SHA = 'a'.repeat(40);
const repository = () => ({
  id: 42,
  node_id: 'R_42',
  full_name: 'acme/widget',
  name: 'widget',
  owner: { login: 'acme' },
});

test('generic certified read turns an issue GET into positive schema-bound evidence', () => {
  const seen: string[] = [];
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'issue',
    grantedPermissions: ['issues:read'],
    parameters: { issue_number: 17 },
    clock: () => '2026-09-19T18:00:00.000Z',
    get: (_token, path) => {
      seen.push(path);
      if (path === '/repos/acme/widget') return repository();
      if (path === '/repos/acme/widget/issues/17') {
        return {
          id: 1700,
          node_id: 'I_17',
          number: 17,
          state: 'open',
          state_reason: null,
          title: 'Observed issue',
          locked: false,
          updated_at: '2026-09-19T17:59:00Z',
        };
      }
      throw new Error('unexpected path:' + path);
    },
  });

  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') return;
  assert.deepEqual(seen, ['/repos/acme/widget', '/repos/acme/widget/issues/17']);
  assert.equal(result.evidence.operation_id, 'issues/get');
  assert.equal(result.evidence.repository_id, 42);
  assert.equal(result.evidence.negative_evidence_authoritative, false);
  assert.equal(result.evidence.optional_absent_paths.includes('pull_request.url'), true);
});

test('workflow run request uses generated parameters and remains positive-only', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'workflow_run',
    grantedPermissions: ['actions:read'],
    parameters: { run_id: 7001, exclude_pull_requests: true },
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      assert.equal(path, '/repos/acme/widget/actions/runs/7001?exclude_pull_requests=true');
      return {
        id: 7001,
        node_id: 'WFR_7001',
        workflow_id: 88,
        run_number: 12,
        run_attempt: 1,
        name: 'Tests',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        head_branch: 'main',
        path: '.github/workflows/tests.yml',
        created_at: '2026-09-19T17:00:00Z',
        updated_at: '2026-09-19T17:05:00Z',
      };
    },
  });

  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') return;
  assert.equal(result.evidence.operation_id, 'actions/get-workflow-run');
  assert.equal(result.evidence.collection, null);
});

test('new pull-request file collection is consumable through the generic certified reader', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'pull_request_files',
    grantedPermissions: ['pull_requests:read'],
    parameters: { pull_number: 17 },
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      assert.equal(path, '/repos/acme/widget/pulls/17/files');
      return [
        {
          sha: SHA,
          filename: 'src/authority/kernel.ts',
          status: 'modified',
          additions: 4,
          deletions: 2,
          changes: 6,
        },
      ];
    },
  });

  assert.equal(result.state, 'page-observed');
  if (result.state !== 'page-observed') return;
  assert.equal(result.evidence.operation_id, 'pulls/list-files');
  assert.deepEqual(result.evidence.collection, {
    kind: 'single-page',
    page: 1,
    page_size: 30,
    completeness: 'page-only',
  });
  assert.equal(Array.isArray(result.value), true);
});

test('new wrapped Actions collection is consumable through the generic certified reader', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'workflow_runs',
    grantedPermissions: ['actions:read'],
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      assert.equal(path, '/repos/acme/widget/actions/runs');
      return {
        total_count: 1,
        workflow_runs: [
          {
            id: 7001,
            node_id: 'WFR_7001',
            workflow_id: 88,
            run_number: 12,
            run_attempt: 1,
            status: 'completed',
            conclusion: 'success',
            head_sha: SHA,
            head_branch: 'main',
            updated_at: '2026-09-19T17:05:00Z',
          },
        ],
      };
    },
  });

  assert.equal(result.state, 'page-observed');
  if (result.state !== 'page-observed') return;
  assert.equal(result.evidence.operation_id, 'actions/list-workflow-runs-for-repo');
  assert.deepEqual(result.evidence.collection, {
    kind: 'single-page',
    page: 1,
    page_size: 30,
    completeness: 'page-only',
  });
  assert.equal((result.value as { total_count: number }).total_count, 1);
});

test('failed or negative provider reads remain indeterminate rather than proving absence', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'release',
    grantedPermissions: ['contents:read'],
    parameters: { release_id: 999 },
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      throw new Error('GITHUB_GET_FAILED:404');
    },
  });

  assert.equal(result.state, 'indeterminate');
  if (result.state !== 'indeterminate') return;
  assert.equal(result.operation_id, 'repos/get-release');
  assert.match(result.observation_error, /404/);
});

test('caller cannot override repository identity or omit exact path coordinates', () => {
  assert.throws(
    () =>
      observeCertifiedGithubSemanticRead('token', {
        repositoryId: 42,
        repositoryFullName: 'acme/widget',
        operation: 'issue',
        grantedPermissions: ['issues:read'],
        parameters: { owner: 'other', issue_number: 17 },
      }),
    /GITHUB_SEMANTIC_READ_PARAMETER_RESERVED:owner/,
  );

  assert.throws(
    () =>
      observeCertifiedGithubSemanticRead('token', {
        repositoryId: 42,
        repositoryFullName: 'acme/widget',
        operation: 'workflow_job',
        grantedPermissions: ['actions:read'],
      }),
    /GITHUB_OPERATION_PARAMETER_REQUIRED:job_id/,
  );
});

test('certified generic read projects away provider fields outside the declared slice', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'issue_comments',
    grantedPermissions: ['issues:read'],
    parameters: { issue_number: 17 },
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      assert.equal(path, '/repos/acme/widget/issues/17/comments');
      return [
        {
          id: 1,
          node_id: 'IC_1',
          user: { login: 'reviewer', id: 99 },
          body: 'please fix the fence',
          created_at: '2026-09-19T17:00:00Z',
          updated_at: '2026-09-19T17:01:00Z',
          html_url: 'https://example.invalid/uncertified',
        },
      ];
    },
  });

  assert.equal(result.state, 'page-observed');
  if (result.state !== 'page-observed') return;
  assert.deepEqual(result.value, [
    {
      id: 1,
      node_id: 'IC_1',
      user: { login: 'reviewer' },
      body: 'please fix the fence',
      created_at: '2026-09-19T17:00:00Z',
      updated_at: '2026-09-19T17:01:00Z',
    },
  ]);
  assert.equal(JSON.stringify(result.value).includes('example.invalid'), false);
});

test('repository issue collection preserves the issue versus pull-request discriminator', () => {
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'issues',
    grantedPermissions: ['issues:read'],
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      assert.equal(path, '/repos/acme/widget/issues');
      return [
        {
          id: 17,
          node_id: 'I_17',
          number: 17,
          state: 'open',
          title: 'Actually a pull request',
          pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/17' },
          updated_at: '2026-09-19T17:01:00Z',
          body: 'uncertified body',
        },
      ];
    },
  });

  assert.equal(result.state, 'page-observed');
  if (result.state !== 'page-observed') return;
  assert.deepEqual(result.value, [
    {
      id: 17,
      node_id: 'I_17',
      number: 17,
      state: 'open',
      title: 'Actually a pull request',
      pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/17' },
      updated_at: '2026-09-19T17:01:00Z',
    },
  ]);
});

test('generic read fails closed before provider access when credential permissions are insufficient', () => {
  let called = false;
  const result = observeCertifiedGithubSemanticRead('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    operation: 'issues',
    grantedPermissions: ['contents:read'],
    get: () => {
      called = true;
      throw new Error('provider should not be called');
    },
  });

  assert.equal(result.state, 'indeterminate');
  assert.equal(called, false);
  if (result.state !== 'indeterminate') return;
  assert.equal(result.observation_error, 'GITHUB_SEMANTIC_READ_PERMISSION_NOT_GRANTED:issues:read');
});

test('GitHub derives an account-complete owned-repository inventory from user identity', () => {
  const seen: string[] = [];
  const inventory = observeGithubAccountRepositories('token', 'acme', {
    clock: () => '2026-09-24T21:00:00.000Z',
    get: (_token, path) => {
      seen.push(path);
      if (path === '/user') return { login: 'acme' };
      if (
        path ===
        '/user/repos?affiliation=owner&direction=asc&page=1&per_page=100&sort=full_name'
      ) {
        return [
          { id: 42, full_name: 'acme/widget', owner: { login: 'acme' } },
          { id: 43, full_name: 'acme/gadget', owner: { login: 'acme' } },
        ];
      }
      throw new Error('unexpected path:' + path);
    },
  });

  assert.deepEqual(inventory, {
    account_login: 'acme',
    repositories: [
      { repository_id: 42, repository_full_name: 'acme/widget' },
      { repository_id: 43, repository_full_name: 'acme/gadget' },
    ],
    observed_at: '2026-09-24T21:00:00.000Z',
    complete: true,
  });
  assert.deepEqual(seen, [
    '/user',
    '/user/repos?affiliation=owner&direction=asc&page=1&per_page=100&sort=full_name',
  ]);
});

test('GitHub account inventory rejects a token for a different account', () => {
  assert.throws(
    () =>
      observeGithubAccountRepositories('token', 'acme', {
        get: (_token, path) => {
          assert.equal(path, '/user');
          return { login: 'other' };
        },
      }),
    /GITHUB_ACTIONS_CAPACITY_ACCOUNT_IDENTITY_MISMATCH/,
  );
});

test('certified Actions load uses the provider-derived inventory and runner labels', () => {
  const inventory = {
    account_login: 'acme',
    repositories: [
      { repository_id: 42, repository_full_name: 'acme/widget' },
      { repository_id: 43, repository_full_name: 'acme/gadget' },
    ],
    observed_at: '2026-09-24T21:00:00.000Z',
    complete: true as const,
  };
  const observation = observeGithubActionsLoad('token', {
    inventory,
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      if (path === '/repos/acme/gadget') {
        return {
          id: 43,
          node_id: 'R_43',
          full_name: 'acme/gadget',
          name: 'gadget',
          owner: { login: 'acme' },
        };
      }
      if (path === '/repos/acme/widget/actions/runs?page=1&per_page=100&status=in_progress') {
        return {
          total_count: 1,
          workflow_runs: [
            {
              id: 7001,
              node_id: 'WFR_7001',
              workflow_id: 88,
              run_number: 12,
              run_attempt: 1,
              status: 'in_progress',
              conclusion: null,
              head_sha: SHA,
              head_branch: 'main',
              updated_at: '2026-09-24T21:00:00Z',
            },
          ],
        };
      }
      if (path === '/repos/acme/gadget/actions/runs?page=1&per_page=100&status=in_progress') {
        return { total_count: 0, workflow_runs: [] };
      }
      if (path === '/repos/acme/widget/actions/runs/7001/jobs?filter=latest&page=1&per_page=100') {
        return {
          total_count: 3,
          jobs: [
            {
              id: 9001,
              run_id: 7001,
              run_attempt: 1,
              node_id: 'WFJ_9001',
              head_sha: SHA,
              name: 'unit',
              status: 'in_progress',
              conclusion: null,
              started_at: '2026-09-24T21:00:00Z',
              completed_at: null,
              labels: ['ubuntu-24.04'],
            },
            {
              id: 9002,
              run_id: 7001,
              run_attempt: 1,
              node_id: 'WFJ_9002',
              head_sha: SHA,
              name: 'self-hosted',
              status: 'in_progress',
              conclusion: null,
              started_at: '2026-09-24T21:00:00Z',
              completed_at: null,
              labels: ['self-hosted', 'Windows', 'X64'],
            },
            {
              id: 9003,
              run_id: 7001,
              run_attempt: 1,
              node_id: 'WFJ_9003',
              head_sha: SHA,
              name: 'queued',
              status: 'queued',
              conclusion: null,
              started_at: '2026-09-24T21:00:00Z',
              completed_at: null,
              labels: ['ubuntu-24.04'],
            },
          ],
        };
      }
      throw new Error('unexpected path:' + path);
    },
  });

  assert.equal(observation.inventory, inventory);
  assert.equal(observation.in_progress_jobs.length, 2);
  assert.equal(observation.in_progress_jobs[0]?.self_hosted, false);
  assert.equal(observation.in_progress_jobs[1]?.self_hosted, true);

  assert.deepEqual(
    projectGithubActionsCapacity({
      observation,
      limit: 20,
      locallyReservedJobs: 17,
      safetyReserveJobs: 1,
    }),
    {
      limit: 20,
      observed_in_progress_jobs: 2,
      observed_hosted_jobs: 1,
      locally_reserved_jobs: 17,
      safety_reserve_jobs: 1,
      available_jobs: 1,
      state: 'available',
    },
  );
});

test('Actions load refuses a provider collection that is not completely observed', () => {
  const inventory = {
    account_login: 'acme',
    repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
    observed_at: '2026-09-24T21:00:00.000Z',
    complete: true as const,
  };
  assert.throws(
    () =>
      observeGithubActionsLoad('token', {
        inventory,
        get: (_token, path) => {
          if (path === '/repos/acme/widget') return repository();
          if (path === '/repos/acme/widget/actions/runs?page=1&per_page=100&status=in_progress') {
            return {
              total_count: 2,
              workflow_runs: [
                {
                  id: 7001,
                  node_id: 'WFR_7001',
                  workflow_id: 88,
                  run_number: 12,
                  run_attempt: 1,
                  status: 'in_progress',
                  conclusion: null,
                  head_sha: SHA,
                  head_branch: 'main',
                  updated_at: '2026-09-24T21:00:00Z',
                },
              ],
            };
          }
          throw new Error('unexpected path:' + path);
        },
      }),
    /GITHUB_ACTIONS_CAPACITY_COLLECTION_INCOMPLETE/,
  );
});

class MemoryReservationStore implements GithubActionsReservationStore {
  headValue: string | null = null;
  value: unknown | null = null;
  revision = 0;
  injectCompetingReservation = false;

  head(): string | null {
    return this.headValue;
  }

  read(): unknown | null {
    return this.value;
  }

  append(expectedHead: string | null, next: unknown): string | null {
    if (expectedHead !== this.headValue) return null;
    if (this.injectCompetingReservation) {
      this.injectCompetingReservation = false;
      this.revision += 1;
      this.headValue = `r${this.revision}`;
      this.value = {
        schema: 'overcenter-github-actions-capacity/v1',
        account_login: 'acme',
        reservations: [{ id: 'other', jobs: 1 }],
      };
      return null;
    }
    this.revision += 1;
    this.headValue = `r${this.revision}`;
    this.value = structuredClone(next);
    return this.headValue;
  }
}

function capacityObservation(hostedJobs: number): GithubActionsLoadObservation {
  return {
    inventory: {
      account_login: 'acme',
      repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
      observed_at: '2026-09-24T21:00:00.000Z',
      complete: true,
    },
    in_progress_jobs: Array.from({ length: hostedJobs }, (_, index) => ({
      repository_id: 42,
      repository_full_name: 'acme/widget',
      run_id: 7001,
      job_id: index + 1,
      self_hosted: false,
    })),
    evidence: [],
  };
}

test('dispatch reservation atomically closes the local capacity race', () => {
  const store = new MemoryReservationStore();
  store.injectCompetingReservation = true;
  const controller = new GithubActionsCapacityController('acme', { store });

  const result = controller.reserveDispatch({
    observation: capacityObservation(18),
    reservationId: 'mine',
    jobs: 1,
    limit: 20,
    safetyReserveJobs: 1,
  });

  assert.equal(result.state, 'saturated');
  assert.equal(result.capacity.observed_hosted_jobs, 18);
  assert.equal(result.capacity.locally_reserved_jobs, 1);
  assert.equal(result.capacity.available_jobs, 0);
});

test('dispatch reservation is durable, idempotent, and releasable', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController('acme', { store });
  const observation = capacityObservation(17);

  const first = controller.reserveDispatch({
    observation,
    reservationId: 'dispatch-1',
    jobs: 1,
    limit: 20,
    safetyReserveJobs: 1,
  });
  assert.equal(first.state, 'reserved');
  if (first.state !== 'reserved') return;
  assert.equal(first.capacity.available_jobs, 1);

  const replay = controller.reserveDispatch({
    observation,
    reservationId: 'dispatch-1',
    jobs: 1,
    limit: 20,
    safetyReserveJobs: 1,
  });
  assert.equal(replay.state, 'reserved');
  assert.equal(store.revision, 1, 'idempotent reservation must not append another authority state');

  const released = controller.releaseDispatch('dispatch-1');
  assert.ok(released);
  assert.equal(store.revision, 2);
});
