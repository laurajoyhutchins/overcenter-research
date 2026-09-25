import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCertifiedGithubSemanticRead } from '../src/providers/github/certified-read.ts';
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
        budget: 18,
        reservations: [
          {
            id: 'other',
            capacity_cost: 1,
            phase: 'reserved',
          },
        ],
      };
      return null;
    }
    this.revision += 1;
    this.headValue = `r${this.revision}`;
    this.value = structuredClone(next);
    return this.headValue;
  }
}

test('Actions capacity reservation needs no GitHub API credential', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  const result = controller.reserveDispatch({
    reservation_id: 'dispatch-1',
    capacity_cost: 6,
  });

  assert.equal(result.state, 'reserved');
  if (result.state !== 'reserved') return;
  assert.equal(result.reservation.capacity_cost, 6);
  assert.equal(result.reservation.phase, 'reserved');
  assert.deepEqual(result.capacity, {
    budget: 18,
    committed_capacity: 6,
    available_capacity: 12,
  });
});

test('declared fan-out cost saturates the semaphore before dispatch', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  assert.equal(
    controller.reserveDispatch({
      reservation_id: 'large',
      capacity_cost: 17,
    }).state,
    'reserved',
  );
  const blocked = controller.reserveDispatch({
    reservation_id: 'another',
    capacity_cost: 2,
  });
  assert.deepEqual(blocked, {
    state: 'saturated',
    capacity: {
      budget: 18,
      committed_capacity: 17,
      available_capacity: 1,
    },
  });
});

test('dispatch reservation atomically closes the capacity race', () => {
  const store = new MemoryReservationStore();
  store.injectCompetingReservation = true;
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  const result = controller.reserveDispatch({
    reservation_id: 'mine',
    capacity_cost: 18,
  });

  assert.equal(result.state, 'saturated');
  assert.deepEqual(result.capacity, {
    budget: 18,
    committed_capacity: 1,
    available_capacity: 17,
  });
});

test('ambiguous pre-dispatch recovery fails closed until explicitly cancelled', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  assert.equal(
    controller.reserveDispatch({ reservation_id: 'dead-controller', capacity_cost: 18 }).state,
    'reserved',
  );
  assert.equal(controller.capacity().available_capacity, 0);

  assert.ok(controller.cancelReservation('dead-controller'));
  assert.equal(controller.capacity().available_capacity, 18);
});

test('dispatch transition is durable and cannot be cancelled as not-dispatched', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  const reserved = controller.reserveDispatch({
    reservation_id: 'dispatch-1',
    capacity_cost: 3,
  });
  assert.equal(reserved.state, 'reserved');

  const dispatched = controller.markDispatched('dispatch-1');
  assert.equal(dispatched.phase, 'dispatched');
  const replay = controller.markDispatched('dispatch-1');
  assert.deepEqual(replay, dispatched);
  assert.equal(store.revision, 2);

  assert.throws(
    () => controller.cancelReservation('dispatch-1'),
    /GITHUB_ACTIONS_CAPACITY_ALREADY_DISPATCHED/,
  );
  assert.equal(controller.capacity().available_capacity, 15);
});

test('reservation replay and release are idempotent', () => {
  const store = new MemoryReservationStore();
  const controller = new GithubActionsCapacityController({
    budget: 18,
    store,
  });

  const first = controller.reserveDispatch({
    reservation_id: 'dispatch-1',
    capacity_cost: 1,
  });
  const replay = controller.reserveDispatch({
    reservation_id: 'dispatch-1',
    capacity_cost: 1,
  });
  assert.deepEqual(replay, first);
  assert.equal(store.revision, 1);

  assert.throws(
    () => controller.completeDispatch('dispatch-1'),
    /GITHUB_ACTIONS_CAPACITY_NOT_DISPATCHED/,
  );
  controller.markDispatched('dispatch-1');
  const released = controller.completeDispatch('dispatch-1');
  assert.ok(released);
  assert.equal(store.revision, 3);
  assert.equal(controller.completeDispatch('dispatch-1'), released);
  assert.equal(store.revision, 3);
});

test('controllers cannot silently disagree about the shared budget', () => {
  const store = new MemoryReservationStore();
  const first = new GithubActionsCapacityController({
    budget: 18,
    store,
  });
  assert.equal(
    first.reserveDispatch({
      reservation_id: 'dispatch-1',
      capacity_cost: 1,
    }).state,
    'reserved',
  );

  const incompatible = new GithubActionsCapacityController({
    budget: 17,
    store,
  });
  assert.throws(() => incompatible.capacity(), /GITHUB_ACTIONS_CAPACITY_STATE_INVALID/);
});
