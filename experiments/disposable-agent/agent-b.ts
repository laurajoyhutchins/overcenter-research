import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('GITHUB_SHA');
const agentOutcome = required('AGENT_A_OUTCOME');
const token = required('GITHUB_TOKEN');
const stateRef = required('STATE_REF');

if (agentOutcome !== 'failure') {
  throw new Error(`AGENT_A_DID_NOT_TERMINATE_AS_EXPECTED: ${agentOutcome}`);
}

const kernel = new GitOvercenterKernel(process.cwd(), {
  remote: 'origin',
  ref: stateRef,
  githubToken: token,
});

const candidates = kernel.inspect().filter(work => {
  if (work.status !== 'EXECUTING') return false;
  const executor = work.packet.executor as Record<string, unknown> | undefined;
  return executor?.provider === 'github-actions/v1'
    && String(executor.workflow_run_id) === workflowRunId
    && String(executor.workflow_run_attempt) === workflowRunAttempt
    && executor.job === 'agent-a';
});
assert.equal(candidates.length, 1, `expected one exact unresolved execution, found ${candidates.length}`);
const work = candidates[0];
assert.ok(work.run_id);
assert.equal(work.postcondition.verifier, 'github-commit-status/v1');
if (work.postcondition.verifier !== 'github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha, 'settlement input identity drifted');

const recovery = kernel.recoverInterrupted(work.run_id, {
  source: 'github-actions-job-supervisor',
  workflow_run_id: workflowRunId,
  workflow_run_attempt: workflowRunAttempt,
  job: 'agent-a',
  outcome: agentOutcome,
});

const settled = kernel.reconcile(work.run_id);
assert.equal(settled.disposition, 'DONE');
assert.equal(settled.verified, true);
assert.equal(settled.observed?.verifier, 'github-commit-status/v1');
assert.equal(settled.observed?.repository_id, work.postcondition.repository_id);
assert.equal(settled.observed?.commit_sha, sourceSha);
assert.equal(settled.observed?.context, work.postcondition.context);
assert.equal(settled.observed?.actual_state, 'success');

const final = kernel.inspect().find(candidate => candidate.id === work.id);
assert.equal(final?.status, 'DONE');

const receipts = kernel.receipts(work.run_id);
assert.deepEqual(receipts.map(receipt => receipt.disposition), ['RECOVERY_REQUIRED', 'DONE']);
assert.ok(receipts.every(receipt => receipt.claim_commit === recovery.claim_commit));

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Trusted recovery / settlement',
    '',
    `- Reconstructed run: \`${work.run_id}\``,
    `- Immutable input: \`${sourceSha}\``,
    `- Canonical repository ID: \`${work.postcondition.repository_id}\``,
    `- Provider verifier: \`${settled.observed?.verifier}\``,
    `- Provider status context: \`${settled.observed?.context}\``,
    `- Provider state: \`${settled.observed?.actual_state}\``,
    `- Final disposition: **${settled.disposition}**`,
    '- Agent A local Git configuration and files were not consulted.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  recovered_run_id: work.run_id,
  recovery_commit: recovery.settlement_commit,
  settlement_commit: settled.settlement_commit,
  disposition: settled.disposition,
  verified: settled.verified,
  observation: settled.observed,
}));
