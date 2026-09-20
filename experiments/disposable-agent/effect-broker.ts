import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github-status-effect.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('disposable-agent');

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
assert.ok(work.run_id);
assert.equal(work.packet.effect_contract,GITHUB_COMMIT_STATUS_EFFECT);
assert.equal(Object.hasOwn(work.packet, 'effect'), false);
assert.equal(work.postcondition.verifier, 'github-commit-status/v2');
if (work.postcondition.verifier !== 'github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha);

const permit = kernel.acquireExecution(work.run_id);
assert.equal(permit.execution_generation, 2);

const effect=await performGithubCommitStatusEffect(kernel,permit,{
  token:required('GITHUB_TOKEN'),
});
assert.equal(effect.commit_sha,sourceSha);
assert.equal(effect.context,work.postcondition.context);
assert.equal(effect.state,work.postcondition.expected_state);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Trusted effect broker',
    '',
    `- Used production provider effect \`src/providers/github-status-effect.ts\` for obligation \`${work.id}\`.`,
    '- Consumed no worker-declared provider coordinates or effect intent.',
    `- Acquired execution generation \`${permit.execution_generation}\`.`,
    '- Certified repository identity before reserving mutation authority.',
    '- Durably reserved the effect immediately before the provider mutation.',
    `- Wrote exactly the declared status context \`${effect.context}\`.`,
    '- Broker now terminates before settlement to force fresh-generation recovery.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:work.id,
  run_id:work.run_id,
  execution_generation:permit.execution_generation,
  effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
  effect,
}));

process.exit(86);
