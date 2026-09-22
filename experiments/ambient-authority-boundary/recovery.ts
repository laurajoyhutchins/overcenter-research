import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const runId = required('GITHUB_RUN_ID');
const attempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('ambient-authority-boundary');
const kernel = new GitOvercenterKernel(process.cwd(), {
  remote: 'origin',
  ref: stateRef,
  githubToken: required('GITHUB_TOKEN'),
});

const candidates = kernel.inspect().filter(work => {
  const executor = work.packet.executor as Record<string, unknown> | undefined;
  return work.status === 'EXECUTING'
    && String(executor?.workflow_run_id) === runId
    && String(executor?.workflow_run_attempt) === attempt;
});
assert.equal(candidates.length, 1);
const work = candidates[0];
assert.ok(work.run_id);
assert.equal(work.execution_generation, 1);
assert.equal(work.postcondition.verifier, 'github-commit-status/v2');
if (work.postcondition.verifier !== 'github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha);

const permit = kernel.acquireExecution(work.run_id);
assert.equal(permit.execution_generation, 2);
const interrupted = kernel.recoverInterrupted(permit, {
  source: 'github-actions-job-supervisor',
  workflow_run_id: runId,
  workflow_run_attempt: attempt,
  job: 'foreign-worker',
  outcome: 'completed-after-ambient-provider-write',
});
assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');

const settled = kernel.reconcile(permit);
assert.equal(settled.disposition, 'DONE');
assert.equal(settled.verified, true);
assert.equal(settled.observed?.verifier, 'github-commit-status/v2');
assert.equal(settled.observed?.actual_state, 'success');
assert.equal(kernel.inspect().find(candidate => candidate.id === work.id)?.status, 'DONE');

console.log(JSON.stringify({
  run_id: work.run_id,
  recovery_generation: permit.execution_generation,
  settlement_commit: settled.settlement_commit,
  disposition: settled.disposition,
}));
