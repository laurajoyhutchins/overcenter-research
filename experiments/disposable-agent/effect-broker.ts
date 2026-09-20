import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
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
assert.equal(
  work.packet.effect_contract,
  'github-commit-status/set-from-postcondition/v1',
);
assert.equal(Object.hasOwn(work.packet, 'effect'), false);

assert.equal(work.postcondition.verifier, 'github-commit-status/v2');
if (work.postcondition.verifier !== 'github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha);

const permit = kernel.acquireExecution(work.run_id);
assert.equal(permit.execution_generation, 2);

await kernel.performEffect(permit, async () => {
  const repositoryIdentity = await github(`/repositories/${work.postcondition.repository_id}`);
  if (!repositoryIdentity.ok) {
    throw new Error(`repository identity read failed: ${repositoryIdentity.status}`);
  }
  const repository = await repositoryIdentity.json() as { id: number; full_name: string };
  assert.equal(repository.id, work.postcondition.repository_id);
  assert.equal(
    repository.full_name.toLowerCase(),
    work.postcondition.repository_full_name.toLowerCase(),
  );

  const status = await github(
    `/repos/${repository.full_name}/statuses/${work.postcondition.commit_sha}`,
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
    `- Required explicit effect contract from immutable authority for obligation \`${work.id}\`.`,
    '- Consumed no worker-declared provider coordinates or effect intent.',
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
  effect_contract: work.packet.effect_contract,
}));

process.exit(86);
