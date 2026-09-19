import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { validateTaskSession } from '../../src/effect-broker.ts';
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
assert.equal(candidates.length, 1, `expected one immutable execution snapshot, found ${candidates.length}`);
const work = candidates[0];
const snapshot = structuredClone(work);
assert.ok(snapshot.run_id);
assert.equal(snapshot.postcondition.verifier, 'github-commit-status/v1');
if (snapshot.postcondition.verifier !== 'github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(snapshot.postcondition.commit_sha, sourceSha);
const trustedSession = validateTaskSession(
  JSON.parse(readFileSync('trusted/task-session.json', 'utf8')),
);
assert.equal(trustedSession.run_id, snapshot.run_id);
assert.equal(trustedSession.obligation_id, snapshot.id);
assert.equal(trustedSession.claimed_revision, snapshot.claimed_revision);
assert.equal(trustedSession.execution_generation, snapshot.execution_generation);
assert.equal(
  trustedSession.execution_authority_commit,
  snapshot.execution_authority_commit,
);

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
assert.equal(attemptedAuthorityRewrite.ok, false, 'worker token unexpectedly rewrote project authority');

const authoritativeRef = await github(`/repos/${repository.full_name}/git/ref/${stateRefApi}`);
if (!authoritativeRef.ok) throw new Error(`authority read failed: ${authoritativeRef.status}`);
const authoritative = await authoritativeRef.json() as { object: { sha: string } };
assert.equal(authoritative.object.sha, snapshot.revision, 'sandbox tampering escaped into Git authority');

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
assert.equal(
  attemptedStatus.status,
  403,
  `worker unexpectedly crossed provider mutation boundary: HTTP ${attemptedStatus.status}`,
);

const acceptedResult = {
  kind: 'github-actions-worker-result/v1',
  obligation_id: snapshot.id,
  source_sha: sourceSha,
};
writeFileSync(
  'worker-result.json',
  `${JSON.stringify(workerResult(trustedSession, acceptedResult), null, 2)}\n`,
);

// The worker may corrupt its downloaded copy, but the broker receives the
// original trusted artifact directly from the authority job.
writeFileSync(
  'trusted/task-session.json',
  `${JSON.stringify({...trustedSession, execution_generation: 999}, null, 2)}\n`,
);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Authority-untrusted Agent A',
    '',
    '- Received the immutable work packet, not an ExecutionPermit.',
    `- Local \`origin\` was repointed to \`${attacker}\`.`,
    '- Local state ref, kernel source, and fake SQLite cache were modified.',
    `- Attempt to rewrite canonical project authority returned HTTP \`${attemptedAuthorityRewrite.status}\`.`,
    `- Attempt to write the declared GitHub status returned HTTP \`${attemptedStatus.status}\`.`,
    '- Emitted only a candidate worker result for deterministic validation.',
    '- Corrupted its local copy of the trusted dispatch session; the broker does not consume that copy.',
    '- Agent A has no `statuses: write` permission.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id: snapshot.id,
  run_id: snapshot.run_id,
  immutable_revision: snapshot.revision,
  authority_rewrite_status: attemptedAuthorityRewrite.status,
  provider_write_status: attemptedStatus.status,
  worker_result: 'worker-result.json',
}));

process.exit(86);
