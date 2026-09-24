import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { admitSourceTaskFromGithubWorkflow } from '../src/source/github-evidence-admission.ts';
import { SOURCE_TASK_SCHEMA } from '../src/source/source-obligation.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';

const TASK_PATH = '.overcenter/promotions/result-a.json';
const WORKFLOW_RUN_ID = 7001;
const WORKFLOW_JOB_ID = 8001;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-promotion-'));
  execFileSync('git', ['-C', root, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Overcenter Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'overcenter-test@local']);
  mkdirSync(join(root, '.overcenter', 'promotions'), { recursive: true });

  const original = {
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: 'Promote the supported bounded result.',
    writable_paths: ['src/a.ts'],
  } as const;
  writeFileSync(join(root, TASK_PATH), JSON.stringify(original, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', TASK_PATH]);
  execFileSync('git', ['-C', root, 'commit', '-m', 'freeze research promotion']);
  const designSha = git(root, ['rev-parse', 'HEAD']);
  const designBlobSha = git(root, ['rev-parse', `${designSha}:${TASK_PATH}`]);

  writeFileSync(
    join(root, TASK_PATH),
    JSON.stringify(
      {
        ...original,
        objective: 'Post-hoc broadened task that must not be admitted.',
        writable_paths: ['src/a.ts', 'src/unrelated.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  execFileSync('git', ['-C', root, 'add', TASK_PATH]);
  execFileSync('git', ['-C', root, 'commit', '-m', 'post-hoc task mutation']);
  const evaluatedSha = git(root, ['rev-parse', 'HEAD']);

  return { root, original, designSha, designBlobSha, evaluatedSha };
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

function workflowRun(evaluatedSha: string, overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_RUN_ID,
    node_id: 'WFR_7001',
    workflow_id: 88,
    run_number: 12,
    run_attempt: 2,
    name: 'Research experiment',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: evaluatedSha,
    head_branch: 'research/result-a',
    path: '.github/workflows/research.yml',
    created_at: '2026-09-24T14:00:00Z',
    updated_at: '2026-09-24T14:05:00Z',
    ...overrides,
  };
}

function workflowJob(evaluatedSha: string, overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_JOB_ID,
    run_id: WORKFLOW_RUN_ID,
    run_attempt: 2,
    node_id: 'WFRJ_8001',
    head_sha: evaluatedSha,
    name: `promote:${TASK_PATH}`,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-24T14:01:00Z',
    completed_at: '2026-09-24T14:04:00Z',
    ...overrides,
  };
}

function provider(
  designSha: string,
  evaluatedSha: string,
  {
    run = workflowRun(evaluatedSha),
    job = workflowJob(evaluatedSha),
    comparison = {},
  }: {
    run?: unknown;
    job?: unknown;
    comparison?: Record<string, unknown>;
  } = {},
): { get: GithubJsonGet; calls: string[] } {
  const calls: string[] = [];
  const get: GithubJsonGet = (_token, path) => {
    calls.push(path);
    if (path === '/repos/acme/widget') return repository();
    if (path === `/repos/acme/widget/actions/runs/${WORKFLOW_RUN_ID}`) return run;
    if (path === `/repos/acme/widget/actions/jobs/${WORKFLOW_JOB_ID}`) return job;
    if (path.startsWith('/repos/acme/widget/compare/')) {
      return {
        status: 'ahead',
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: designSha },
        merge_base_commit: { sha: designSha },
        ...comparison,
      };
    }
    throw new Error('unexpected provider path:' + path);
  };
  return { get, calls };
}

function request(designSha: string, evaluatedSha: string) {
  return {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    designSha,
    evaluatedSha,
    taskPath: TASK_PATH,
    workflowRunId: WORKFLOW_RUN_ID,
    workflowJobId: WORKFLOW_JOB_ID,
    workflowName: 'Research experiment',
    workflowPath: '.github/workflows/research.yml',
    minimumRunAttempt: 2,
  };
}

test('exact GitHub evidence admits only the source task frozen at the design commit', () => {
  const f = fixture();
  try {
    const p = provider(f.designSha, f.evaluatedSha);
    const admitted = admitSourceTaskFromGithubWorkflow(
      f.root,
      'token',
      request(f.designSha, f.evaluatedSha),
      { get: p.get, clock: () => '2026-09-24T14:06:00.000Z' },
    );

    assert.deepEqual(admitted.task, f.original);
    assert.equal(admitted.design.commit_sha, f.designSha);
    assert.equal(admitted.design.task_blob_sha, f.designBlobSha);
    assert.equal(admitted.workflow_run.value.head_sha, f.evaluatedSha);
    assert.equal(admitted.workflow_run.evidence.operation_id, 'actions/get-workflow-run');
    assert.equal(admitted.promotion_job.value.name, `promote:${TASK_PATH}`);
    assert.equal(
      admitted.promotion_job.evidence.operation_id,
      'actions/get-job-for-workflow-run',
    );
    assert.equal(admitted.ancestry.relation, 'ancestor');
    assert.equal(JSON.stringify(admitted.task).includes('unrelated.ts'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a green experiment does not promote when its promotion job is skipped', () => {
  const f = fixture();
  try {
    const p = provider(f.designSha, f.evaluatedSha, {
      job: workflowJob(f.evaluatedSha, { conclusion: 'skipped' }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(
          f.root,
          'token',
          request(f.designSha, f.evaluatedSha),
          { get: p.get },
        ),
      /SOURCE_PROMOTION_JOB_NOT_SUCCESSFUL/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('workflow identity, exact revision, and explicit certification attempt all fail closed', () => {
  const f = fixture();
  try {
    const stale = provider(f.designSha, f.evaluatedSha, {
      run: workflowRun('f'.repeat(40)),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(
          f.root,
          'token',
          request(f.designSha, f.evaluatedSha),
          { get: stale.get },
        ),
      /SOURCE_PROMOTION_EVALUATED_SHA_MISMATCH/,
    );

    const early = provider(f.designSha, f.evaluatedSha, {
      run: workflowRun(f.evaluatedSha, { run_attempt: 1 }),
      job: workflowJob(f.evaluatedSha, { run_attempt: 1 }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(
          f.root,
          'token',
          request(f.designSha, f.evaluatedSha),
          { get: early.get },
        ),
      /SOURCE_PROMOTION_WORKFLOW_ATTEMPT_TOO_EARLY/,
    );

    const wrongJob = provider(f.designSha, f.evaluatedSha, {
      job: workflowJob(f.evaluatedSha, { name: 'ordinary-regression' }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(
          f.root,
          'token',
          request(f.designSha, f.evaluatedSha),
          { get: wrongJob.get },
        ),
      /SOURCE_PROMOTION_WORKFLOW_JOB_MISMATCH/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a task cannot use evidence from a revision outside its frozen design ancestry', () => {
  const f = fixture();
  try {
    const other = 'e'.repeat(40);
    const p = provider(f.designSha, f.evaluatedSha, {
      comparison: {
        status: 'diverged',
        ahead_by: 1,
        behind_by: 1,
        merge_base_commit: { sha: other },
      },
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(
          f.root,
          'token',
          request(f.designSha, f.evaluatedSha),
          { get: p.get },
        ),
      /SOURCE_PROMOTION_DESIGN_NOT_ANCESTOR/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('invalid frozen source task fails before any provider evidence is consulted', () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, TASK_PATH),
      JSON.stringify({
        schema: SOURCE_TASK_SCHEMA,
        kind: 'source-change',
        objective: 'Bad.',
        writable_paths: ['../escape.ts'],
      }),
    );
    execFileSync('git', ['-C', f.root, 'add', TASK_PATH]);
    execFileSync('git', ['-C', f.root, 'commit', '-m', 'bad design']);
    const badDesign = git(f.root, ['rev-parse', 'HEAD']);
    execFileSync('git', ['-C', f.root, 'commit', '--allow-empty', '-m', 'evaluate bad design']);
    const evaluated = git(f.root, ['rev-parse', 'HEAD']);
    const p = provider(badDesign, evaluated);

    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(badDesign, evaluated), {
          get: p.get,
        }),
      /SOURCE_TASK_WRITABLE_PATH_INVALID/,
    );
    assert.deepEqual(p.calls, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
