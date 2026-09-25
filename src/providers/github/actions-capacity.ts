import {
  observeCertifiedGithubSemanticRead,
  type CertifiedGithubSemanticReadEvidence,
} from './certified-read.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

const ACTIONS_PAGE_SIZE = 100;

export interface GithubActionsRepositoryScope {
  repository_id: number;
  repository_full_name: string;
}

export interface GithubActionsInProgressJob {
  repository_id: number;
  repository_full_name: string;
  run_id: number;
  job_id: number;
  job_name: string;
  head_sha: string;
}

export interface GithubActionsLoadObservation {
  repositories: readonly GithubActionsRepositoryScope[];
  scope_completeness: 'account-complete' | 'partial';
  in_progress_jobs: readonly GithubActionsInProgressJob[];
  evidence: readonly CertifiedGithubSemanticReadEvidence[];
  observed_from: string;
  observed_through: string;
  completeness: 'single-page-certified';
}

export interface GithubActionsCapacityProjection {
  limit: number;
  observed_in_progress_jobs: number;
  locally_reserved_jobs: number;
  safety_reserve_jobs: number;
  committed_jobs: number;
  available_jobs: number;
  state: 'available' | 'saturated' | 'indeterminate';
  reason: 'repository-scope-incomplete' | null;
  conservative_runner_classification: true;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function nonnegativeSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function positiveSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function certifiedPage({
  token,
  repository,
  operation,
  parameters,
  get,
  clock,
}: {
  token: string;
  repository: GithubActionsRepositoryScope;
  operation: 'workflow_runs' | 'workflow_jobs';
  parameters: Record<string, string | number | boolean>;
  get: GithubJsonGet;
  clock: () => string;
}) {
  const result = observeCertifiedGithubSemanticRead(token, {
    repositoryId: repository.repository_id,
    repositoryFullName: repository.repository_full_name,
    operation,
    parameters,
    grantedPermissions: ['actions:read'],
    get,
    clock,
  });
  if (result.state === 'indeterminate') {
    throw new Error(
      `GITHUB_ACTIONS_CAPACITY_OBSERVATION_INDETERMINATE:${result.operation_id}:${result.observation_error}`,
    );
  }
  if (result.state !== 'page-observed') {
    throw new Error(`GITHUB_ACTIONS_CAPACITY_COLLECTION_EXPECTED:${result.evidence.operation_id}`);
  }
  return result;
}

function assertSinglePageComplete(
  totalCount: number,
  members: readonly unknown[],
  operationId: string,
): void {
  if (totalCount !== members.length) {
    throw new Error(
      `GITHUB_ACTIONS_CAPACITY_COLLECTION_NOT_SINGLE_PAGE_COMPLETE:${operationId}:${members.length}/${totalCount}`,
    );
  }
  if (members.length > ACTIONS_PAGE_SIZE) {
    throw new Error(
      `GITHUB_ACTIONS_CAPACITY_COLLECTION_OVERSIZED:${operationId}:${members.length}`,
    );
  }
}

function validateRepositoryScope(
  repository: GithubActionsRepositoryScope,
): GithubActionsRepositoryScope {
  positiveSafeInteger(repository.repository_id, 'GITHUB_ACTIONS_CAPACITY_REPOSITORY_ID_INVALID');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository.repository_full_name)) {
    throw new Error('GITHUB_ACTIONS_CAPACITY_REPOSITORY_INVALID');
  }
  return repository;
}

export function observeGithubActionsLoad(
  token: string,
  {
    repositories,
    scopeCompleteness,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    repositories: readonly GithubActionsRepositoryScope[];
    scopeCompleteness: 'account-complete' | 'partial';
    get?: GithubJsonGet;
    clock?: () => string;
  },
): GithubActionsLoadObservation {
  if (repositories.length === 0) throw new Error('GITHUB_ACTIONS_CAPACITY_SCOPE_EMPTY');

  const ordered = [...repositories].map(validateRepositoryScope).sort((left, right) =>
    left.repository_full_name.localeCompare(right.repository_full_name),
  );
  const seenRepositories = new Set<string>();
  for (const repository of ordered) {
    if (seenRepositories.has(repository.repository_full_name)) {
      throw new Error(
        `GITHUB_ACTIONS_CAPACITY_REPOSITORY_DUPLICATE:${repository.repository_full_name}`,
      );
    }
    seenRepositories.add(repository.repository_full_name);
  }

  const evidence: CertifiedGithubSemanticReadEvidence[] = [];
  const jobs: GithubActionsInProgressJob[] = [];
  const seenJobs = new Set<string>();

  for (const repository of ordered) {
    const runsPage = certifiedPage({
      token,
      repository,
      operation: 'workflow_runs',
      parameters: { page: 1, per_page: ACTIONS_PAGE_SIZE, status: 'in_progress' },
      get,
      clock,
    });
    evidence.push(runsPage.evidence);

    const runsValue = record(runsPage.value, 'GITHUB_ACTIONS_CAPACITY_RUNS_VALUE_INVALID');
    const runs = runsValue.workflow_runs;
    if (!Array.isArray(runs)) throw new Error('GITHUB_ACTIONS_CAPACITY_RUNS_INVALID');
    const runTotal = nonnegativeSafeInteger(
      runsValue.total_count,
      'GITHUB_ACTIONS_CAPACITY_RUN_TOTAL_INVALID',
    );
    assertSinglePageComplete(runTotal, runs, runsPage.evidence.operation_id);

    for (const rawRun of runs) {
      const run = record(rawRun, 'GITHUB_ACTIONS_CAPACITY_RUN_INVALID');
      const runId = positiveSafeInteger(run.id, 'GITHUB_ACTIONS_CAPACITY_RUN_ID_INVALID');
      if (run.status !== 'in_progress') {
        throw new Error(`GITHUB_ACTIONS_CAPACITY_RUN_FILTER_MISMATCH:${runId}`);
      }

      const jobsPage = certifiedPage({
        token,
        repository,
        operation: 'workflow_jobs',
        parameters: {
          run_id: runId,
          filter: 'latest',
          page: 1,
          per_page: ACTIONS_PAGE_SIZE,
        },
        get,
        clock,
      });
      evidence.push(jobsPage.evidence);

      const jobsValue = record(jobsPage.value, 'GITHUB_ACTIONS_CAPACITY_JOBS_VALUE_INVALID');
      const members = jobsValue.jobs;
      if (!Array.isArray(members)) throw new Error('GITHUB_ACTIONS_CAPACITY_JOBS_INVALID');
      const jobTotal = nonnegativeSafeInteger(
        jobsValue.total_count,
        'GITHUB_ACTIONS_CAPACITY_JOB_TOTAL_INVALID',
      );
      assertSinglePageComplete(jobTotal, members, jobsPage.evidence.operation_id);

      for (const rawJob of members) {
        const job = record(rawJob, 'GITHUB_ACTIONS_CAPACITY_JOB_INVALID');
        if (job.status !== 'in_progress') continue;
        const jobId = positiveSafeInteger(job.id, 'GITHUB_ACTIONS_CAPACITY_JOB_ID_INVALID');
        const observedRunId = positiveSafeInteger(
          job.run_id,
          'GITHUB_ACTIONS_CAPACITY_JOB_RUN_ID_INVALID',
        );
        if (observedRunId !== runId) {
          throw new Error(`GITHUB_ACTIONS_CAPACITY_JOB_RUN_MISMATCH:${jobId}`);
        }
        const identity = `${repository.repository_id}:${jobId}`;
        if (seenJobs.has(identity)) {
          throw new Error(`GITHUB_ACTIONS_CAPACITY_JOB_DUPLICATE:${identity}`);
        }
        seenJobs.add(identity);
        jobs.push({
          repository_id: repository.repository_id,
          repository_full_name: repository.repository_full_name,
          run_id: runId,
          job_id: jobId,
          job_name: requiredString(job.name, 'GITHUB_ACTIONS_CAPACITY_JOB_NAME_INVALID'),
          head_sha: requiredString(job.head_sha, 'GITHUB_ACTIONS_CAPACITY_JOB_HEAD_INVALID'),
        });
      }
    }
  }

  const observedTimes = evidence.map((item) => item.observed_at).sort();
  if (observedTimes.length === 0) throw new Error('GITHUB_ACTIONS_CAPACITY_EVIDENCE_EMPTY');

  return {
    repositories: ordered,
    scope_completeness: scopeCompleteness,
    in_progress_jobs: jobs,
    evidence,
    observed_from: observedTimes[0]!,
    observed_through: observedTimes.at(-1)!,
    completeness: 'single-page-certified',
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
  positiveSafeInteger(limit, 'GITHUB_ACTIONS_CAPACITY_LIMIT_INVALID');
  nonnegativeSafeInteger(
    locallyReservedJobs,
    'GITHUB_ACTIONS_CAPACITY_LOCAL_RESERVATIONS_INVALID',
  );
  nonnegativeSafeInteger(safetyReserveJobs, 'GITHUB_ACTIONS_CAPACITY_SAFETY_RESERVE_INVALID');

  const observed = observation.in_progress_jobs.length;
  const committed = observed + locallyReservedJobs + safetyReserveJobs;
  if (observation.scope_completeness !== 'account-complete') {
    return {
      limit,
      observed_in_progress_jobs: observed,
      locally_reserved_jobs: locallyReservedJobs,
      safety_reserve_jobs: safetyReserveJobs,
      committed_jobs: committed,
      available_jobs: 0,
      state: 'indeterminate',
      reason: 'repository-scope-incomplete',
      conservative_runner_classification: true,
    };
  }

  const available = Math.max(0, limit - committed);
  return {
    limit,
    observed_in_progress_jobs: observed,
    locally_reserved_jobs: locallyReservedJobs,
    safety_reserve_jobs: safetyReserveJobs,
    committed_jobs: committed,
    available_jobs: available,
    state: available > 0 ? 'available' : 'saturated',
    reason: null,
    // The current certified workflow-job slice does not include runner labels.
    // Counting every in-progress job therefore fails safe when self-hosted jobs exist.
    conservative_runner_classification: true,
  };
}
