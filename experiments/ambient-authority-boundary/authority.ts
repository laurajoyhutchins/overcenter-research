import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path: string): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return response.json();
}

const repository = required('GITHUB_REPOSITORY');
const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('ambient-authority-boundary');

const repositoryInfo = await github(`/repos/${repository}`);
assert.ok(Number.isSafeInteger(repositoryInfo.id));

const proofId = `ambient-authority-${workflowRunId}-${workflowRunAttempt}`;
const context = `overcenter/ambient-authority/${workflowRunId}/${workflowRunAttempt}`;

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin', ref: stateRef });
kernel.initialize();
kernel.define({
  id: proofId,
  packet: {
    kind: 'ambient-authority-boundary/v1',
    executor: {
      provider: 'github-actions/v1',
      repository_id: repositoryInfo.id,
      workflow_run_id: workflowRunId,
      workflow_run_attempt: workflowRunAttempt,
      job: 'worker',
    },
    exact_input: {
      kind: 'git-commit/v1',
      repository_id: repositoryInfo.id,
      commit_sha: sourceSha,
    },
    effect_contract: 'github-commit-status/set-from-postcondition/v1',
  },
  postcondition: {
    verifier: 'github-commit-status/v2',
    provider: 'github',
    repository_id: repositoryInfo.id,
    repository_full_name: repository,
    commit_sha: sourceSha,
    context,
    expected_state: 'success',
  },
});

const work = kernel.inspect().find(candidate => candidate.id === proofId);
assert.ok(work);
const run = kernel.claim(work.id, work.revision);
console.log(JSON.stringify({
  obligation_id: proofId,
  run_id: run.id,
  claim_commit: run.claim_commit,
  state_ref: stateRef,
  context,
}));
