import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const runId = required('GITHUB_RUN_ID');
const attempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('ambient-authority-boundary');
const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin', ref: stateRef });

const candidates = kernel.inspect().filter(work => {
  const executor = work.packet.executor as Record<string, unknown> | undefined;
  return work.status === 'EXECUTING'
    && String(executor?.workflow_run_id) === runId
    && String(executor?.workflow_run_attempt) === attempt;
});
assert.equal(candidates.length, 1);
const work = candidates[0];
assert.equal(work.postcondition.verifier, 'github-commit-status/v2');
if (work.postcondition.verifier !== 'github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha, sourceSha);

const packetBytes = JSON.stringify(work.packet);
const packetSha = createHash('sha256').update(packetBytes).digest('hex');
const response = await github(
  `/repos/${work.postcondition.repository_full_name}/statuses/${work.postcondition.commit_sha}`,
  {
    method: 'POST',
    body: JSON.stringify({
      state: work.postcondition.expected_state,
      context: work.postcondition.context,
      description: 'controlled substrate must not have provider authority',
    }),
  },
);
assert.equal(response.status, 403);
assert.equal(kernel.inspect().find(candidate => candidate.id === work.id)?.status, 'EXECUTING');

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `packet_sha256=${packetSha}\n`);
console.log(JSON.stringify({ packet_sha256: packetSha, provider_write_status: response.status }));
