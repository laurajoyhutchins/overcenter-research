import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const packetSha = createHash('sha256').update(JSON.stringify(work.packet)).digest('hex');
assert.equal(packetSha, required('CONTROL_PACKET_SHA256'), 'worker packet changed between substrate arms');

const response = await github(
  `/repos/${work.postcondition.repository_full_name}/statuses/${work.postcondition.commit_sha}`,
  {
    method: 'POST',
    body: JSON.stringify({
      state: work.postcondition.expected_state,
      context: work.postcondition.context,
      description: 'ambient host capability bypassed worker effect confinement',
    }),
  },
);
assert.equal(response.status, 201, `expected ambient provider mutation to succeed, got HTTP ${response.status}`);

// Provider truth changed, but this worker has no contents:write capability and has
// performed no Overcenter settlement transition.
const after = kernel.inspect().find(candidate => candidate.id === work.id);
assert.equal(after?.status, 'EXECUTING');

console.log(JSON.stringify({
  packet_sha256: packetSha,
  provider_write_status: response.status,
  authoritative_status_after_provider_write: after?.status,
}));
