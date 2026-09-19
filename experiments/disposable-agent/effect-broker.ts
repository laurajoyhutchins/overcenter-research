import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  executeAuthorizedEffect,
  validateTaskSession,
} from '../../src/effect-broker.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('disposable-agent');
const token = required('GITHUB_TOKEN');

const session = validateTaskSession(
  JSON.parse(readFileSync('trusted/task-session.json', 'utf8')),
);
const candidateResult = JSON.parse(
  readFileSync('candidate/worker-result.json', 'utf8'),
);

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin', ref: stateRef });
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
assert.equal(work.run_id, session.run_id);
assert.equal(work.id, session.obligation_id);
assert.equal(work.claimed_revision, session.claimed_revision);
assert.equal(work.execution_generation, session.execution_generation);
assert.equal(work.execution_authority_commit, session.execution_authority_commit);
assert.equal(work.postcondition.verifier, 'github-commit-status/v1');
if (work.postcondition.verifier !== 'github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha);

const realization = kernel.acceptRealization(session, candidateResult);
const attempt = await executeAuthorizedEffect(
  kernel,
  session,
  { githubToken: token },
);

assert.equal(attempt.broker_execution_generation, 2);
assert.equal(attempt.evidence.provider, 'github');
assert.equal(attempt.evidence.operation, 'create-commit-status');
assert.equal(attempt.evidence.repository_id, work.postcondition.repository_id);
assert.equal(attempt.evidence.commit_sha, sourceSha);
assert.equal(attempt.evidence.context, work.postcondition.context);
assert.equal(attempt.evidence.state, work.postcondition.expected_state);
assert.equal(kernel.hasUnresolvedEffect(session.run_id), true);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Trusted effect broker',
    '',
    `- Reused trusted dispatch session generation \`${session.execution_generation}\`.`,
    `- Deterministically accepted realization \`${realization.result_digest}\`.`,
    `- Rotated provider authority to generation \`${attempt.broker_execution_generation}\`.`,
    `- Reserved exact effect digest \`${attempt.authorized_effect.effect_digest}\` before mutation.`,
    `- Wrote status context \`${attempt.evidence.context}\` through the pinned provider adapter.`,
    '- Broker now terminates before settlement to force fresh-generation recovery.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id: work.id,
  run_id: session.run_id,
  worker_generation: session.execution_generation,
  broker_generation: attempt.broker_execution_generation,
  realization_commit: realization.realization_commit,
  reservation_commit: attempt.reservation_commit,
  effect_digest: attempt.authorized_effect.effect_digest,
  provider_status_id: attempt.evidence.provider_status_id,
}));

process.exit(86);
