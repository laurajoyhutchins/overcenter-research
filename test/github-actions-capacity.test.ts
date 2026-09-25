import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observeGithubActionsLoad,
  projectGithubActionsCapacity,
} from '../src/providers/github/actions-capacity.ts';

const SHA = 'a'.repeat(40);

function repository(id: number, fullName: string) {
  const [owner, name] = fullName.split('/');
  return {
    id,
    node_id: `R_${id}`,
    full_name: fullName,
    name,
    owner: { login: owner },
  };
}

function run(id: number) {
  return {
    id,
    node_id: `WFR_${id}`,
    workflow_id: 88,
    run_number: id,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    head_sha: SHA,
    head_branch: 'main',
    updated_at: '2026-09-24T21:00:00Z',
  };
}

function job(id: number, runId: number, status: 'queued' | 'in_progress' | 'completed') {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    node_id: `WFJ_${id}`,
    head_sha: SHA,
    name: `job-${id}`,
    status,
    conclusion: status === 'completed' ? 'success' : null,
    started_at: '2026-09-24T21:00:00Z',
    completed_at: status === 'completed' ? '2026-09-24T21:01:00Z' : null,
  };
}

test('certified Actions observations project account-scope in-progress job load', () => {
  const paths: string[] = [];
  let tick = 0;
  const observation = observeGithubActionsLoad('token', {
    repositories: [
      { repository_id: 42, repository_full_name: 'acme/widget' },
      { repository_id: 43, repository_full_name: 'acme/gadget' },
    ],
    scopeCompleteness: 'account-complete',
    clock: () => `2026-09-24T21:00:0${tick++}.000Z`,
    get: (_token, path) => {
      paths.push(path);
      if (path === '/repos/acme/widget') return repository(42, 'acme/widget');
      if (path === '/repos/acme/gadget') return repository(43, 'acme/gadget');
      if (path === '/repos/acme/widget/actions/runs?page=1&per_page=100&status=in_progress') {
        return { total_count: 1, workflow_runs: [run(7001)] };
      }
      if (path === '/repos/acme/gadget/actions/runs?page=1&per_page=100&status=in_progress') {
        return { total_count: 1, workflow_runs: [run(8001)] };
      }
      if (
        path ===
        '/repos/acme/widget/actions/runs/7001/jobs?filter=latest&page=1&per_page=100'
      ) {
        return {
          total_count: 3,
          jobs: [job(1, 7001, 'in_progress'), job(2, 7001, 'queued'), job(3, 7001, 'completed')],
        };
      }
      if (
        path ===
        '/repos/acme/gadget/actions/runs/8001/jobs?filter=latest&page=1&per_page=100'
      ) {
        return {
          total_count: 1,
          jobs: [job(4, 8001, 'in_progress')],
        };
      }
      throw new Error('unexpected path:' + path);
    },
  });

  assert.equal(observation.completeness, 'single-page-certified');
  assert.equal(observation.in_progress_jobs.length, 2);
  assert.deepEqual(
    observation.in_progress_jobs.map((member) => member.job_id),
    [4, 1],
  );
  assert.equal(observation.evidence.length, 4);
  assert.equal(
    paths.filter((path) => path.endsWith('/actions/runs?page=1&per_page=100&status=in_progress'))
      .length,
    2,
  );
});

test('capacity subtracts provider-observed occupancy, local reservations, and safety reserve', () => {
  const observation = {
    repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
    scope_completeness: 'account-complete' as const,
    in_progress_jobs: Array.from({ length: 17 }, (_, index) => ({
      repository_id: 42,
      repository_full_name: 'acme/widget',
      run_id: 7001,
      job_id: index + 1,
      job_name: `job-${index + 1}`,
      head_sha: SHA,
    })),
    evidence: [],
    observed_from: '2026-09-24T21:00:00.000Z',
    observed_through: '2026-09-24T21:00:00.000Z',
    completeness: 'single-page-certified' as const,
  };

  assert.deepEqual(
    projectGithubActionsCapacity({
      observation,
      limit: 20,
      locallyReservedJobs: 1,
      safetyReserveJobs: 1,
    }),
    {
      limit: 20,
      observed_in_progress_jobs: 17,
      locally_reserved_jobs: 1,
      safety_reserve_jobs: 1,
      committed_jobs: 19,
      available_jobs: 1,
      state: 'available',
      reason: null,
      conservative_runner_classification: true,
    },
  );

  assert.equal(
    projectGithubActionsCapacity({
      observation,
      limit: 20,
      locallyReservedJobs: 2,
      safetyReserveJobs: 1,
    }).state,
    'saturated',
  );
});

test('queued jobs do not consume the observed concurrency budget', () => {
  const observation = observeGithubActionsLoad('token', {
    repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
    scopeCompleteness: 'account-complete',
    get: (_token, path) => {
      if (path === '/repos/acme/widget') return repository(42, 'acme/widget');
      if (path === '/repos/acme/widget/actions/runs?page=1&per_page=100&status=in_progress') {
        return { total_count: 1, workflow_runs: [run(7001)] };
      }
      if (
        path ===
        '/repos/acme/widget/actions/runs/7001/jobs?filter=latest&page=1&per_page=100'
      ) {
        return {
          total_count: 2,
          jobs: [job(1, 7001, 'queued'), job(2, 7001, 'in_progress')],
        };
      }
      throw new Error('unexpected path:' + path);
    },
  });

  const capacity = projectGithubActionsCapacity({ observation, limit: 20 });
  assert.equal(capacity.observed_in_progress_jobs, 1);
  assert.equal(capacity.available_jobs, 19);
});

test('capacity observation fails closed on a partial Actions collection', () => {
  assert.throws(
    () =>
      observeGithubActionsLoad('token', {
        repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
        get: (_token, path) => {
          if (path === '/repos/acme/widget') return repository(42, 'acme/widget');
          if (
            path === '/repos/acme/widget/actions/runs?page=1&per_page=100&status=in_progress'
          ) {
            return { total_count: 2, workflow_runs: [run(7001)] };
          }
          throw new Error('unexpected path:' + path);
        },
      }),
    /GITHUB_ACTIONS_CAPACITY_COLLECTION_NOT_SINGLE_PAGE_COMPLETE:actions\/list-workflow-runs-for-repo:1\/2/,
  );
});


test('partial repository scope cannot claim account runner capacity', () => {
  const observation = {
    repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
    scope_completeness: 'partial' as const,
    in_progress_jobs: [],
    evidence: [],
    observed_from: '2026-09-24T21:00:00.000Z',
    observed_through: '2026-09-24T21:00:00.000Z',
    completeness: 'single-page-certified' as const,
  };

  assert.deepEqual(projectGithubActionsCapacity({ observation, limit: 20 }), {
    limit: 20,
    observed_in_progress_jobs: 0,
    locally_reserved_jobs: 0,
    safety_reserve_jobs: 0,
    committed_jobs: 0,
    available_jobs: 0,
    state: 'indeterminate',
    reason: 'repository-scope-incomplete',
    conservative_runner_classification: true,
  });
});

test('capacity projection rejects invalid limits and reservation counts', () => {
  const observation = {
    repositories: [{ repository_id: 42, repository_full_name: 'acme/widget' }],
    scope_completeness: 'account-complete' as const,
    in_progress_jobs: [],
    evidence: [],
    observed_from: '2026-09-24T21:00:00.000Z',
    observed_through: '2026-09-24T21:00:00.000Z',
    completeness: 'single-page-certified' as const,
  };

  assert.throws(
    () => projectGithubActionsCapacity({ observation, limit: 0 }),
    /GITHUB_ACTIONS_CAPACITY_LIMIT_INVALID/,
  );
  assert.throws(
    () =>
      projectGithubActionsCapacity({
        observation,
        limit: 20,
        locallyReservedJobs: -1,
      }),
    /GITHUB_ACTIONS_CAPACITY_LOCAL_RESERVATIONS_INVALID/,
  );
});
