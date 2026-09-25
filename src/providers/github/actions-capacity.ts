import {
  observeCertifiedGithubSemanticRead,
  type CertifiedGithubSemanticReadEvidence,
} from './certified-read.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

const PAGE_SIZE = 100;

export interface GithubActionsRepositoryScope {
  repository_id: number;
  repository_full_name: string;
}

export interface GithubActionsObservedJob {
  repository_id: number;
  repository_full_name: string;
  run_id: number;
  job_id: number;
  self_hosted: boolean;
}

export interface GithubAccountRepositoryInventory {
  account_login: string;
  repositories: readonly GithubActionsRepositoryScope[];
  observed_at: string;
  complete: true;
}

export interface GithubActionsLoadObservation {
  inventory: GithubAccountRepositoryInventory;
  in_progress_jobs: readonly GithubActionsObservedJob[];
  evidence: readonly CertifiedGithubSemanticReadEvidence[];
}

export interface GithubActionsCapacityProjection {
  limit: number;
  observed_in_progress_jobs: number;
  observed_hosted_jobs: number;
  locally_reserved_jobs: number;
  safety_reserve_jobs: number;
  available_jobs: number;
  state: 'available' | 'saturated';
}

interface WorkflowRunsPage {
  total_count: number;
  workflow_runs: Array<{ id: number }>;
}

interface WorkflowJobsPage {
  total_count: number;
  jobs: Array<{
    id: number;
    run_id: number;
    status: string;
    labels: string[];
  }>;
}

function certifiedPage(
  token: string,
  repository: GithubActionsRepositoryScope,
  operation: 'workflow_runs' | 'workflow_jobs',
  parameters: Record<string, string | number | boolean>,
  get: GithubJsonGet,
  clock: () => string,
) {
  const result = observeCertifiedGithubSemanticRead(token, {
    repositoryId: repository.repository_id,
    repositoryFullName: repository.repository_full_name,
    operation,
    parameters,
    grantedPermissions: ['actions:read'],
    get,
    clock,
  });
  if (result.state !== 'page-observed') {
    const detail =
      result.state === 'indeterminate' ? result.observation_error : 'COLLECTION_EXPECTED';
    throw new Error(`GITHUB_ACTIONS_CAPACITY_OBSERVATION_INDETERMINATE:${detail}`);
  }
  return result;
}

function requireComplete(total: number, members: readonly unknown[], operationId: string): void {
  if (total !== members.length) {
    throw new Error(
      `GITHUB_ACTIONS_CAPACITY_COLLECTION_INCOMPLETE:${operationId}:${members.length}/${total}`,
    );
  }
}

function nonnegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

export function observeGithubAccountRepositories(
  token: string,
  accountLogin: string,
  {
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    get?: GithubJsonGet;
    clock?: () => string;
  } = {},
): GithubAccountRepositoryInventory {
  const identity = get(token, '/user') as { login?: unknown };
  if (identity.login !== accountLogin) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_ACCOUNT_IDENTITY_MISMATCH');
  }

  const repositories: GithubActionsRepositoryScope[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 1000; page += 1) {
    const value = get(
      token,
      `/user/repos?affiliation=owner&direction=asc&page=${page}&per_page=${PAGE_SIZE}&sort=full_name`,
    );
    if (!Array.isArray(value)) {
      throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVENTORY_INVALID');
    }
    for (const raw of value) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVENTORY_INVALID');
      }
      const repository = raw as {
        id?: unknown;
        full_name?: unknown;
        owner?: { login?: unknown };
      };
      if (
        !Number.isSafeInteger(repository.id) ||
        (repository.id as number) < 1 ||
        typeof repository.full_name !== 'string' ||
        repository.owner?.login !== accountLogin
      ) {
        throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVENTORY_INVALID');
      }
      if (seen.has(repository.id as number)) {
        throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVENTORY_DUPLICATE');
      }
      seen.add(repository.id as number);
      repositories.push({
        repository_id: repository.id as number,
        repository_full_name: repository.full_name,
      });
    }
    if (value.length < PAGE_SIZE) {
      return {
        account_login: accountLogin,
        repositories,
        observed_at: clock(),
        complete: true,
      };
    }
  }
  throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVENTORY_PAGE_LIMIT');
}

export function observeGithubActionsLoad(
  token: string,
  {
    inventory,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    inventory: GithubAccountRepositoryInventory;
    get?: GithubJsonGet;
    clock?: () => string;
  },
): GithubActionsLoadObservation {
  if (inventory.complete !== true) throw new Error('GITHUB_ACTIONS_CAPACITY_INVENTORY_INCOMPLETE');

  const evidence: CertifiedGithubSemanticReadEvidence[] = [];
  const jobs: GithubActionsObservedJob[] = [];

  for (const repository of inventory.repositories) {
    const runsPage = certifiedPage(
      token,
      repository,
      'workflow_runs',
      { page: 1, per_page: PAGE_SIZE, status: 'in_progress' },
      get,
      clock,
    );
    evidence.push(runsPage.evidence);
    const runs = runsPage.value as WorkflowRunsPage;
    requireComplete(runs.total_count, runs.workflow_runs, runsPage.evidence.operation_id);

    for (const run of runs.workflow_runs) {
      const jobsPage = certifiedPage(
        token,
        repository,
        'workflow_jobs',
        { run_id: run.id, filter: 'latest', page: 1, per_page: PAGE_SIZE },
        get,
        clock,
      );
      evidence.push(jobsPage.evidence);
      const page = jobsPage.value as WorkflowJobsPage;
      requireComplete(page.total_count, page.jobs, jobsPage.evidence.operation_id);

      for (const job of page.jobs) {
        if (job.status !== 'in_progress') continue;
        jobs.push({
          repository_id: repository.repository_id,
          repository_full_name: repository.repository_full_name,
          run_id: run.id,
          job_id: job.id,
          self_hosted: job.labels.includes('self-hosted'),
        });
      }
    }
  }

  return {
    inventory,
    in_progress_jobs: jobs,
    evidence,
  };
}

export function projectGithubActionsCapacity({
  observation,
  limit,
  locallyReservedJobs = 0,
  safetyReserveJobs = 0,
}: {
  observation: GithubActionsLoadObservation;
  limit: number;
  locallyReservedJobs?: number;
  safetyReserveJobs?: number;
}): GithubActionsCapacityProjection {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_LIMIT_INVALID');
  }
  nonnegativeInteger(locallyReservedJobs, 'GITHUB_ACTIONS_CAPACITY_LOCAL_RESERVATIONS_INVALID');
  nonnegativeInteger(safetyReserveJobs, 'GITHUB_ACTIONS_CAPACITY_SAFETY_RESERVE_INVALID');

  const observed = observation.in_progress_jobs.length;
  const hosted = observation.in_progress_jobs.filter((job) => !job.self_hosted).length;

  const available = Math.max(0, limit - hosted - locallyReservedJobs - safetyReserveJobs);
  return {
    limit,
    observed_in_progress_jobs: observed,
    observed_hosted_jobs: hosted,
    locally_reserved_jobs: locallyReservedJobs,
    safety_reserve_jobs: safetyReserveJobs,
    available_jobs: available,
    state: available > 0 ? 'available' : 'saturated',
  };
}
