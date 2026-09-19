import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const token = required('GITHUB_TOKEN');
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('disposable-agent');

const intent = JSON.parse(readFileSync('candidate/effect-intent.json', 'utf8')) as {
  schema?: string;
  obligation_id?: string;
  run_id?: string;
  claimed_revision?: string;
  effect?: Record<string, unknown>;
};
assert.equal(intent.schema, 'overcenter-effect-intent-v1');

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
assert.equal(intent.obligation_id, work.id);
assert.equal(intent.run_id, work.run_id);
assert.equal(intent.claimed_revision, work.claimed_revision);

const declaredEffect = work.packet.effect as Record<string, unknown> | undefined;
assert.ok(declaredEffect);
assert.deepEqual(intent.effect, declaredEffect, 'worker intent drifted from authoritative obligation');

assert.equal(work.postcondition.verifier, 'github-commit-status/v2');
if (work.postcondition.verifier !== 'github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.deepEqual(declaredEffect, {
  kind: 'github-commit-status/v1',
  repository_id: work.postcondition.repository_id,
  commit_sha: work.postcondition.commit_sha,
  context: work.postcondition.context,
  state: work.postcondition.expected_state,
});
assert.equal(work.postcondition.commit_sha, sourceSha);

const permit = kernel.acquireExecution(work.run_id);
assert.equal(permit.execution_generation, 2);

await kernel.performEffect(permit, async () => {
  const status = await github(
    `/repos/${work.postcondition.repository_full_name}/statuses/${work.postcondition.commit_sha}`,
    {
      method: 'POST',
      body: JSON.stringify({
        state: work.postcondition.expected_state,
        context: work.postcondition.context,
        description: 'Overcenter trusted effect broker',
      }),
    },
  );
  if (status.status !== 201) {
    throw new Error(`status creation failed ${status.status}: ${await status.text()}`);
  }
});

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Trusted effect broker',
    '',
    `- Validated EffectIntent for obligation \`${work.id}\`.`,
    `- Acquired execution generation \`${permit.execution_generation}\`.`,
    '- Durably reserved the effect before the provider mutation.',
    `- Wrote exactly the declared status context \`${work.postcondition.context}\`.`,
    '- Broker now terminates before settlement to force fresh-generation recovery.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id: work.id,
  run_id: work.run_id,
  execution_generation: permit.execution_generation,
  effect: declaredEffect,
}));

process.exit(86);
