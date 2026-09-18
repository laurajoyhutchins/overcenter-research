import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const repository = required('GITHUB_REPOSITORY');
const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const agentOutcome = required('AGENT_A_OUTCOME');

if (agentOutcome !== 'failure') {
  throw new Error(`AGENT_A_DID_NOT_TERMINATE_AS_EXPECTED: ${agentOutcome}`);
}

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin' });
const candidates = kernel.inspect().filter(work => {
  if (work.status !== 'EXECUTING') return false;
  const executor = work.packet.executor as Record<string, unknown> | undefined;
  return executor?.provider === 'github-actions/v1'
    && executor.repository === repository
    && String(executor.workflow_run_id) === workflowRunId
    && String(executor.workflow_run_attempt) === workflowRunAttempt
    && executor.job === 'agent-a';
});

assert.equal(candidates.length, 1, `expected one exact unresolved Agent A run, found ${candidates.length}`);
const work = candidates[0];
assert.ok(work.run_id, 'unresolved work must carry run identity');

const recovery = kernel.recoverInterrupted(work.run_id, {
  source: 'github-actions-job-supervisor',
  repository,
  workflow_run_id: workflowRunId,
  workflow_run_attempt: workflowRunAttempt,
  job: 'agent-a',
  outcome: agentOutcome,
});

const settled = kernel.reconcile(work.run_id);
assert.equal(settled.disposition, 'DONE');
assert.equal(settled.verified, true);

const final = kernel.inspect().find(candidate => candidate.id === work.id);
assert.equal(final?.status, 'DONE');

const receipts = kernel.receipts(work.run_id);
assert.deepEqual(receipts.map(receipt => receipt.disposition), ['RECOVERY_REQUIRED', 'DONE']);
assert.ok(receipts.every(receipt => receipt.claim_commit === recovery.claim_commit));

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Agent B',
    '',
    '- This job started on a fresh GitHub-hosted runner.',
    `- GitHub supervisor fact for Agent A: \`${agentOutcome}\``,
    `- Reconstructed Overcenter run from Git: \`${work.run_id}\``,
    `- Provider verifier: \`${settled.observed?.verifier}\``,
    `- Observed provider SHA: \`${settled.observed?.actual_sha}\``,
    `- Final disposition: **${settled.disposition}**`,
    '- No Agent A cache, worktree, database, output payload, or process memory was consumed.',
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
