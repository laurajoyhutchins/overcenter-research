import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { admitSourceTaskFromGithubWorkflow } from '../src/source/github-evidence-admission.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';
import { SOURCE_TASK_SCHEMA } from '../src/source/source-obligation.ts';

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
  const currentSha = git(root, ['rev-parse', 'HEAD']);

  return { root, original, designSha, designBlobSha, currentSha };
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

function workflowRun(designSha: string, overrides: Record<string, unknown> = {}) {
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
    head_sha: designSha,
    head_branch: 'research/result-a',
    path: '.github/workflows/research.yml',
    created_at: '2026-09-24T14:00:00Z',
    updated_at: '2026-09-24T14:05:00Z',
    ...overrides,
  };
}

function workflowJob(designSha: string, overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_JOB_ID,
    run_id: WORKFLOW_RUN_ID,
    run_attempt: 2,
    node_id: 'WFRJ_8001',
    head_sha: designSha,
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
  {
    run = workflowRun(designSha),
    job = workflowJob(designSha),
  }: {
    run?: unknown;
    job?: unknown;
  } = {},
): { get: GithubJsonGet; calls: string[] } {
  const calls: string[] = [];
  const get: GithubJsonGet = (_token, path) => {
    calls.push(path);
    if (path === '/repos/acme/widget') return repository();
    if (path === `/repos/acme/widget/actions/runs/${WORKFLOW_RUN_ID}`) return run;
    if (path === `/repos/acme/widget/actions/jobs/${WORKFLOW_JOB_ID}`) return job;
    throw new Error('unexpected provider path:' + path);
  };
  return { get, calls };
}

function request(designSha: string) {
  return {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    designSha,
    taskPath: TASK_PATH,
    workflowRunId: WORKFLOW_RUN_ID,
    workflowJobId: WORKFLOW_JOB_ID,
    workflowName: 'Research experiment',
    workflowPath: '.github/workflows/research.yml',
    minimumRunAttempt: 2,
  };
}

test('exact GitHub evidence admits only the source task frozen at the executed design commit', () => {
  const f = fixture();
  try {
    assert.notEqual(f.currentSha, f.designSha);
    const p = provider(f.designSha);
    const admitted = admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
      get: p.get,
      clock: () => '2026-09-24T14:06:00.000Z',
    });

    assert.deepEqual(admitted.task, f.original);
    assert.equal(admitted.design.commit_sha, f.designSha);
    assert.equal(admitted.design.task_blob_sha, f.designBlobSha);
    assert.equal(admitted.workflow_run.value.head_sha, f.designSha);
    assert.equal(admitted.workflow_run.evidence.operation_id, 'actions/get-workflow-run');
    assert.equal(admitted.promotion_job.value.name, `promote:${TASK_PATH}`);
    assert.equal(admitted.promotion_job.evidence.operation_id, 'actions/get-job-for-workflow-run');
    assert.equal(JSON.stringify(admitted.task).includes('unrelated.ts'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a green experiment does not promote when its promotion job is skipped', () => {
  const f = fixture();
  try {
    const p = provider(f.designSha, {
      job: workflowJob(f.designSha, { conclusion: 'skipped' }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
          get: p.get,
        }),
      /SOURCE_PROMOTION_JOB_NOT_SUCCESSFUL/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('workflow identity, exact design revision, and certification attempt fail closed', () => {
  const f = fixture();
  try {
    const stale = provider(f.designSha, {
      run: workflowRun('f'.repeat(40)),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
          get: stale.get,
        }),
      /SOURCE_PROMOTION_DESIGN_SHA_MISMATCH/,
    );

    const early = provider(f.designSha, {
      run: workflowRun(f.designSha, { run_attempt: 1 }),
      job: workflowJob(f.designSha, { run_attempt: 1 }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
          get: early.get,
        }),
      /SOURCE_PROMOTION_WORKFLOW_ATTEMPT_TOO_EARLY/,
    );

    const wrongWorkflow = provider(f.designSha, {
      run: workflowRun(f.designSha, { path: '.github/workflows/unrelated.yml' }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
          get: wrongWorkflow.get,
        }),
      /SOURCE_PROMOTION_WORKFLOW_IDENTITY_MISMATCH/,
    );

    const wrongJob = provider(f.designSha, {
      job: workflowJob(f.designSha, { name: 'ordinary-regression' }),
    });
    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
          get: wrongJob.get,
        }),
      /SOURCE_PROMOTION_WORKFLOW_JOB_MISMATCH/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('workflow job must belong to the exact successful run and attempt', () => {
  const f = fixture();
  try {
    for (const job of [
      workflowJob(f.designSha, { run_id: WORKFLOW_RUN_ID + 1 }),
      workflowJob(f.designSha, { run_attempt: 3 }),
      workflowJob('e'.repeat(40)),
    ]) {
      const p = provider(f.designSha, { job });
      assert.throws(
        () =>
          admitSourceTaskFromGithubWorkflow(f.root, 'token', request(f.designSha), {
            get: p.get,
          }),
        /SOURCE_PROMOTION_WORKFLOW_JOB_MISMATCH/,
      );
    }
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
    const p = provider(badDesign);

    assert.throws(
      () =>
        admitSourceTaskFromGithubWorkflow(f.root, 'token', request(badDesign), {
          get: p.get,
        }),
      /SOURCE_TASK_WRITABLE_PATH_INVALID/,
    );
    assert.deepEqual(p.calls, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
