import { execFileSync } from 'node:child_process';

import { validPath } from '../execution/assignment-capsule.ts';
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
import { validateSourceTaskPacket, type SourceTaskPacket } from './source-obligation.ts';

export interface GithubWorkflowSourceAdmissionRequest {
  repositoryId: number;
  repositoryFullName: string;
  designSha: string;
  taskPath: string;
  workflowRunId: number;
  workflowJobId: number;
  workflowPath: string;
}

export interface AdmittedGithubWorkflowSourceTask {
  task: SourceTaskPacket;
  design: {
    commit_sha: string;
    task_path: string;
    task_blob_sha: string;
  };
  workflow_run_evidence: CertifiedGithubSemanticReadEvidence;
  promotion_job_evidence: CertifiedGithubSemanticReadEvidence;
}

function positiveSafeInteger(value: unknown, error: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(error);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function frozenSourceTask(
  repo: string,
  designSha: string,
  taskPath: string,
): { task: SourceTaskPacket; blobSha: string } {
  if (
    !validPath(taskPath) ||
    taskPath.includes('\\') ||
    taskPath.includes(':') ||
    taskPath.split('/').includes('.git')
  ) {
    throw new Error('SOURCE_PROMOTION_TASK_PATH_INVALID');
  }
  if (!isGithubObjectId(designSha)) throw new Error('SOURCE_PROMOTION_DESIGN_SHA_INVALID');
  if (git(repo, ['cat-file', '-t', designSha]) !== 'commit') {
    throw new Error('SOURCE_PROMOTION_DESIGN_NOT_COMMIT');
  }
  if (git(repo, ['ls-tree', '--name-only', designSha, '--', taskPath]) !== taskPath) {
    throw new Error('SOURCE_PROMOTION_TASK_NOT_IN_DESIGN');
  }

  const blobSha = git(repo, ['rev-parse', `${designSha}:${taskPath}`]);
  if (!isGithubObjectId(blobSha) || git(repo, ['cat-file', '-t', blobSha]) !== 'blob') {
    throw new Error('SOURCE_PROMOTION_TASK_BLOB_INVALID');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(git(repo, ['show', `${designSha}:${taskPath}`]));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('SOURCE_PROMOTION_TASK_JSON_INVALID');
    throw error;
  }
  return { task: validateSourceTaskPacket(parsed), blobSha: blobSha.toLowerCase() };
}

function requiredString(
  value: Record<string, unknown>,
  name: string,
  error: string,
): string {
  const member = value[name];
  if (typeof member !== 'string' || member.length === 0) throw new Error(error);
  return member;
}

function requireSuccessfulWorkflowRun(
  value: unknown,
  request: GithubWorkflowSourceAdmissionRequest,
): number {
  if (!isData(value)) throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_INVALID');
  positiveSafeInteger(value.id, 'SOURCE_PROMOTION_WORKFLOW_RUN_ID_INVALID');
  positiveSafeInteger(value.run_attempt, 'SOURCE_PROMOTION_WORKFLOW_RUN_ATTEMPT_INVALID');
  if (value.id !== request.workflowRunId) throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_MISMATCH');
  if (!sameGithubObjectId(requiredString(value, 'head_sha', 'SOURCE_PROMOTION_WORKFLOW_RUN_INVALID'), request.designSha)) {
    throw new Error('SOURCE_PROMOTION_DESIGN_SHA_MISMATCH');
  }
  if (requiredString(value, 'path', 'SOURCE_PROMOTION_WORKFLOW_RUN_INVALID') !== request.workflowPath) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_IDENTITY_MISMATCH');
  }
  if (value.status !== 'completed' || value.conclusion !== 'success') {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_NOT_SUCCESSFUL');
  }
  return value.run_attempt;
}

function requireSuccessfulPromotionJob(
  value: unknown,
  request: GithubWorkflowSourceAdmissionRequest,
  runAttempt: number,
): void {
  if (!isData(value)) throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_INVALID');
  positiveSafeInteger(value.id, 'SOURCE_PROMOTION_WORKFLOW_JOB_ID_INVALID');
  positiveSafeInteger(value.run_id, 'SOURCE_PROMOTION_WORKFLOW_JOB_RUN_ID_INVALID');
  positiveSafeInteger(value.run_attempt, 'SOURCE_PROMOTION_WORKFLOW_JOB_ATTEMPT_INVALID');
  if (
    value.id !== request.workflowJobId ||
    value.run_id !== request.workflowRunId ||
    value.run_attempt !== runAttempt ||
    !sameGithubObjectId(
      requiredString(value, 'head_sha', 'SOURCE_PROMOTION_WORKFLOW_JOB_INVALID'),
      request.designSha,
    ) ||
    value.name !== `promote:${request.taskPath}`
  ) {
    throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_MISMATCH');
  }
  if (value.status !== 'completed' || value.conclusion !== 'success') {
    throw new Error('SOURCE_PROMOTION_JOB_NOT_SUCCESSFUL');
  }
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
  positiveSafeInteger(request.workflowRunId, 'SOURCE_PROMOTION_WORKFLOW_RUN_ID_INVALID');
  positiveSafeInteger(request.workflowJobId, 'SOURCE_PROMOTION_WORKFLOW_JOB_ID_INVALID');
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
  if (runRead.state === 'indeterminate') {
    throw new Error(`SOURCE_PROMOTION_WORKFLOW_RUN_INDETERMINATE:${runRead.observation_error}`);
  }
  if (runRead.state !== 'observed') throw new Error('SOURCE_PROMOTION_WORKFLOW_RUN_NOT_SINGLE');
  const runAttempt = requireSuccessfulWorkflowRun(runRead.value, request);

  const jobRead = observeCertifiedGithubSemanticRead(token, {
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    operation: 'workflow_job',
    parameters: { job_id: request.workflowJobId },
    grantedPermissions: ['actions:read'],
    get,
    clock,
  });
  if (jobRead.state === 'indeterminate') {
    throw new Error(`SOURCE_PROMOTION_WORKFLOW_JOB_INDETERMINATE:${jobRead.observation_error}`);
  }
  if (jobRead.state !== 'observed') throw new Error('SOURCE_PROMOTION_WORKFLOW_JOB_NOT_SINGLE');
  requireSuccessfulPromotionJob(jobRead.value, request, runAttempt);

  return {
    task: structuredClone(frozen.task),
    design: {
      commit_sha: request.designSha.toLowerCase(),
      task_path: request.taskPath,
      task_blob_sha: frozen.blobSha,
    },
    workflow_run_evidence: structuredClone(runRead.evidence),
    promotion_job_evidence: structuredClone(jobRead.evidence),
  };
}
