import { execFileSync } from 'node:child_process';

import { validPath } from '../execution/assignment-capsule.ts';
import {
  validateSourceTaskPacket,
  type SourceTaskPacket,
} from './source-obligation.ts';
import {
  observeCertifiedGithubCommitAncestry,
  type CertifiedGithubCommitAncestryEvidence,
} from '../providers/github/certified-ancestry.ts';
import {
  observeCertifiedGithubSemanticRead,
  type CertifiedGithubSemanticReadEvidence,
} from '../providers/github/certified-read.ts';
import {
  githubGet,
  isGithubObjectId,
  sameGithubObjectId,
  type GithubJsonGet,
} from '../providers/github/rest.ts';
import { isData } from '../validation.ts';

export interface GithubWorkflowSourceAdmissionRequest {
  repositoryId: number;
  repositoryFullName: string;
  designSha: string;
  evaluatedSha: string;
  taskPath: string;
  workflowRunId: number;
  workflowJobId: number;
  workflowName: string;
  workflowPath: string;
  minimumRunAttempt?: number;
}

interface WorkflowRunObservation {
  id: number;
  run_attempt: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  path: string;
}

interface WorkflowJobObservation {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface AdmittedGithubWorkflowSourceTask {
  task: SourceTaskPacket;
  design: {
    commit_sha: string;
    task_path: string;
    task_blob_sha: string;
  };
  workflow_run: {
    value: WorkflowRunObservation;
    evidence: CertifiedGithubSemanticReadEvidence;
  };
  promotion_job: {
    value: WorkflowJobObservation;
    evidence: CertifiedGithubSemanticReadEvidence;
  };
  ancestry: CertifiedGithubCommitAncestryEvidence;
}

function positiveSafeInteger(value: unknown, error: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(error);
}

function exactGithubObjectId(value: unknown, error: string): asserts value is string {
  if (!isGithubObjectId(value)) throw new Error(error);
}

function safeTaskPath(value: string): void {
  if (
    !validPath(value) ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').includes('.git')
  ) {
    throw new Error('SOURCE_PROMOTION_TASK_PATH_INVALID');
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function frozenSourceTask(
  repo: string,
  designSha: string,
  taskPath: string,
): { task: SourceTaskPacket; blobSha: string } {
  safeTaskPath(taskPath);
  const listed = git(repo, ['ls-tree', '--name-only', designSha, '--', taskPath]);
  if (listed !== taskPath) throw new Error('SOURCE_PROMOTION_TASK_NOT_IN_DESIGN');

  const object = git(repo, ['rev-parse', `${designSha}:${taskPath}`]);
  exactGithubObjectId(object, 'SOURCE_PROMOTION_TASK_BLOB_INVALID');
  if (git(repo, ['cat-file', '-t', object]) !== 'blob') {
    throw new Error('SOURCE_PROMOTION_TASK_NOT_BLOB');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(git(repo, ['show', `${designSha}:${taskPath}`]));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('SOURCE_PROMOTION_TASK_JSON_INVALID');
    throw error;
  }
  return { task: validateSourceTaskPacket(parsed), blobSha: object.toLowerCase() };
}

function workflowRun(value: unknown): WorkflowRunObservation {
  if (!isData(value)) throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_INVALID');
  positiveSafeInteger(value.id, 'SOURCE_PROMOTION_WORKFLOW_RUN_ID_INVALID');
  positiveSafeInteger(value.run_attempt, 'SOURCE_PROMOTION_WORKFLOW_RUN_ATTEMPT_INVALID');
  if (
    typeof value.name !== 'string' ||
    typeof value.event !== 'string' ||
    typeof value.status !== 'string' ||
    (value.conclusion !== null && typeof value.conclusion !== 'string') ||
    typeof value.head_sha !== 'string' ||
    typeof value.path !== 'string'
  ) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_INVALID');
  }
  return {
    id: value.id,
    run_attempt: value.run_attempt,
    name: value.name,
    event: value.event,
    status: value.status,
    conclusion: value.conclusion,
    head_sha: value.head_sha,
    path: value.path,
  };
}

function workflowJob(value: unknown): WorkflowJobObservation {
  if (!isData(value)) throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_INVALID');
  positiveSafeInteger(value.id, 'SOURCE_PROMOTION_WORKFLOW_JOB_ID_INVALID');
  positiveSafeInteger(value.run_id, 'SOURCE_PROMOTION_WORKFLOW_JOB_RUN_ID_INVALID');
  positiveSafeInteger(value.run_attempt, 'SOURCE_PROMOTION_WORKFLOW_JOB_ATTEMPT_INVALID');
  if (
    typeof value.head_sha !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.status !== 'string' ||
    (value.conclusion !== null && typeof value.conclusion !== 'string')
  ) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_INVALID');
  }
  return {
    id: value.id,
    run_id: value.run_id,
    run_attempt: value.run_attempt,
    head_sha: value.head_sha,
    name: value.name,
    status: value.status,
    conclusion: value.conclusion,
  };
}

export function admitSourceTaskFromGithubWorkflow(
  repo: string,
  token: string,
  request: GithubWorkflowSourceAdmissionRequest,
  {
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    get?: GithubJsonGet;
    clock?: () => string;
  } = {},
): AdmittedGithubWorkflowSourceTask {
  exactGithubObjectId(request.designSha, 'SOURCE_PROMOTION_DESIGN_SHA_INVALID');
  exactGithubObjectId(request.evaluatedSha, 'SOURCE_PROMOTION_EVALUATED_SHA_INVALID');
  positiveSafeInteger(request.workflowRunId, 'SOURCE_PROMOTION_WORKFLOW_RUN_ID_INVALID');
  positiveSafeInteger(request.workflowJobId, 'SOURCE_PROMOTION_WORKFLOW_JOB_ID_INVALID');
  const minimumRunAttempt = request.minimumRunAttempt ?? 1;
  positiveSafeInteger(minimumRunAttempt, 'SOURCE_PROMOTION_MINIMUM_RUN_ATTEMPT_INVALID');
  if (!request.workflowName) throw new Error('SOURCE_PROMOTION_WORKFLOW_NAME_INVALID');
  if (!request.workflowPath) throw new Error('SOURCE_PROMOTION_WORKFLOW_PATH_INVALID');
  const frozen = frozenSourceTask(repo, request.designSha, request.taskPath);

  const runRead = observeCertifiedGithubSemanticRead(token, {
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    operation: 'workflow_run',
    parameters: { run_id: request.workflowRunId },
    grantedPermissions: ['actions:read'],
    get,
    clock,
  });
  if (runRead.state !== 'observed') {
    throw new Error(
      `SOURCE_PROMOTION_WORKFLOW_RUN_INDETERMINATE:${runRead.observation_error}`,
    );
  }
  const run = workflowRun(runRead.value);
  if (run.id !== request.workflowRunId) throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_MISMATCH');
  if (!sameGithubObjectId(run.head_sha, request.evaluatedSha)) {
    throw new Error('SOURCE_PROMOTION_EVALUATED_SHA_MISMATCH');
  }
  if (run.name !== request.workflowName || run.path !== request.workflowPath) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_IDENTITY_MISMATCH');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_NOT_SUCCESSFUL');
  }
  if (run.run_attempt < minimumRunAttempt) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_ATTEMPT_TOO_EARLY');
  }

  const jobRead = observeCertifiedGithubSemanticRead(token, {
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    operation: 'workflow_job',
    parameters: { job_id: request.workflowJobId },
    grantedPermissions: ['actions:read'],
    get,
    clock,
  });
  if (jobRead.state !== 'observed') {
    throw new Error(
      `SOURCE_PROMOTION_WORKFLOW_JOB_INDETERMINATE:${jobRead.observation_error}`,
    );
  }
  const job = workflowJob(jobRead.value);
  if (
    job.id !== request.workflowJobId ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    !sameGithubObjectId(job.head_sha, request.evaluatedSha) ||
    job.name !== `promote:${request.taskPath}`
  ) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_MISMATCH');
  }
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    throw new Error('SOURCE_PROMOTION_JOB_NOT_SUCCESSFUL');
  }

  const ancestry = observeCertifiedGithubCommitAncestry(token, {
    repositoryFullName: request.repositoryFullName,
    ancestorSha: request.designSha,
    descendantSha: request.evaluatedSha,
    get,
    clock,
  });
  if (ancestry.state !== 'ancestor') {
    throw new Error('SOURCE_PROMOTION_DESIGN_NOT_ANCESTOR');
  }

  return {
    task: structuredClone(frozen.task),
    design: {
      commit_sha: request.designSha.toLowerCase(),
      task_path: request.taskPath,
      task_blob_sha: frozen.blobSha,
    },
    workflow_run: {
      value: run,
      evidence: structuredClone(runRead.evidence),
    },
    promotion_job: {
      value: job,
      evidence: structuredClone(jobRead.evidence),
    },
    ancestry: structuredClone(ancestry.evidence),
  };
}
