import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { bindTaskSession } from '../../src/effect-broker.ts';
import { workerResult } from '../../src/realization.ts';

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
const stateRefApi = stateRef.replace(/^refs\//, '');

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin', ref: stateRef });
const candidates = kernel.inspect().filter(work => {
  if (work.status !== 'EXECUTING') return false;
  const executor = work.packet.executor as Record<string, unknown> | undefined;
  return executor?.provider === 'github-actions/v1'
    && String(executor.workflow_run_id) === workflowRunId
    && String(executor.workflow_run_attempt) === workflowRunAttempt
    && executor.job === 'agent-a';
});
assert.equal(candidates.length, 1);
const snapshot = structuredClone(candidates[0]);
const session=bindTaskSession(snapshot);
assert.equal(snapshot.execution_generation,1);
assert.equal(snapshot.postcondition.verifier, 'github-commit-status/v1');
if (snapshot.postcondition.verifier !== 'github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(snapshot.postcondition.commit_sha, sourceSha);

const attacker = join(tmpdir(), `overcenter-attacker-${workflowRunId}.git`);
execFileSync('git', ['init', '--bare', attacker], { stdio: 'ignore' });
execFileSync('git', ['remote', 'set-url', 'origin', attacker], { stdio: 'ignore' });
execFileSync('git', ['update-ref', stateRef, sourceSha], { stdio: 'ignore' });
writeFileSync('src/git-kernel.ts', '// Agent A locally replaced the kernel. This must not affect authority.\n');
writeFileSync('agent-cache.sqlite', 'arbitrary disposable local database');

const repositoryIdentity = await github(`/repositories/${snapshot.postcondition.repository_id}`);
if (!repositoryIdentity.ok) throw new Error(`repository identity read failed: ${repositoryIdentity.status}`);
const repository = await repositoryIdentity.json() as { id: number; full_name: string };
assert.equal(repository.id, snapshot.postcondition.repository_id);

const attemptedAuthorityRewrite = await github(
  `/repos/${repository.full_name}/git/refs/${stateRefApi}`,
  {
    method: 'PATCH',
    body: JSON.stringify({ sha: sourceSha, force: true }),
  },
);
assert.equal(attemptedAuthorityRewrite.status,403);

const authoritativeRef = await github(`/repos/${repository.full_name}/git/ref/${stateRefApi}`);
if (!authoritativeRef.ok) throw new Error(`authority read failed: ${authoritativeRef.status}`);
const authoritative = await authoritativeRef.json() as { object: { sha: string } };
assert.equal(authoritative.object.sha, snapshot.revision);

const attemptedStatus = await github(
  `/repos/${repository.full_name}/statuses/${snapshot.postcondition.commit_sha}`,
  {
    method: 'POST',
    body: JSON.stringify({
      state: snapshot.postcondition.expected_state,
      context: snapshot.postcondition.context,
      description: 'This write must be rejected for the worker job',
    }),
  },
);
assert.equal(attemptedStatus.status,403);

const result=workerResult(session,{
  kind:'github-actions-trust-boundary-result/v1',
  source_sha:sourceSha,
  authority_rewrite_status:attemptedAuthorityRewrite.status,
  provider_write_status:attemptedStatus.status,
});
writeFileSync('worker-result.json',JSON.stringify(result,null,2)+'\n');

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Authority-untrusted Agent A',
    '',
    '- Received work state but no provider mutation credential or execution capability.',
    `- Local authority and source were tampered with without changing canonical Git authority.`,
    `- Authority rewrite returned HTTP \`${attemptedAuthorityRewrite.status}\`.`,
    `- Provider write returned HTTP \`${attemptedStatus.status}\`.`,
    '- Emitted result data only. It did not emit readiness or provider coordinates as authority.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:snapshot.id,
  generation:snapshot.execution_generation,
  worker_result:'worker-result.json',
}));

process.exit(86);
