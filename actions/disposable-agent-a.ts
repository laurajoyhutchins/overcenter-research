import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

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
const sourceSha = required('GITHUB_SHA');

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin' });
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
assert.equal(snapshot.postcondition.verifier, 'github-commit-status/v1');
if (snapshot.postcondition.verifier !== 'github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(snapshot.postcondition.commit_sha, sourceSha);

const attacker = join(tmpdir(), `overcenter-attacker-${workflowRunId}.git`);
execFileSync('git', ['init', '--bare', attacker], { stdio: 'ignore' });
execFileSync('git', ['remote', 'set-url', 'origin', attacker], { stdio: 'ignore' });
execFileSync('git', ['update-ref', 'refs/overcenter/state', sourceSha], { stdio: 'ignore' });
writeFileSync('src/git-kernel.ts', '// Agent A locally replaced the kernel. This must not affect authority.\n');
writeFileSync('agent-cache.sqlite', 'arbitrary disposable local database');

const repositoryIdentity = await github(`/repositories/${snapshot.postcondition.repository_id}`);
if (!repositoryIdentity.ok) throw new Error(`repository identity read failed: ${repositoryIdentity.status}`);
const repository = await repositoryIdentity.json() as { id: number; full_name: string };
assert.equal(repository.id, snapshot.postcondition.repository_id);

const attemptedAuthorityRewrite = await github(
  `/repos/${repository.full_name}/git/refs/overcenter/state`,
  {
    method: 'PATCH',
    body: JSON.stringify({ sha: sourceSha, force: true }),
  },
);
assert.equal(attemptedAuthorityRewrite.ok, false, 'execution token unexpectedly rewrote project authority');

const authoritativeRef = await github(`/repos/${repository.full_name}/git/ref/overcenter/state`);
if (!authoritativeRef.ok) throw new Error(`authority read failed: ${authoritativeRef.status}`);
const authoritative = await authoritativeRef.json() as { object: { sha: string } };
assert.equal(authoritative.object.sha, snapshot.revision, 'sandbox tampering escaped into Git authority');

const status = await github(
  `/repos/${repository.full_name}/statuses/${snapshot.postcondition.commit_sha}`,
  {
    method: 'POST',
    body: JSON.stringify({
      state: snapshot.postcondition.expected_state,
      context: snapshot.postcondition.context,
      description: 'Overcenter disposable execution effect',
    }),
  },
);
if (status.status !== 201) throw new Error(`status creation failed ${status.status}: ${await status.text()}`);

for (let i = 0; i < 100; i += 1) {
  const distractor = await github(
    `/repos/${repository.full_name}/statuses/${snapshot.postcondition.commit_sha}`,
    {
      method: 'POST',
      body: JSON.stringify({
        state: 'pending',
        context: `${snapshot.postcondition.context}/pagination-distractor/${i}`,
        description: 'Pagination proof distractor',
      }),
    },
  );
  if (distractor.status !== 201) {
    throw new Error(`distractor status creation failed ${distractor.status}: ${await distractor.text()}`);
  }
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Potentially untrusted Agent A',
    '',
    '- Received an already-claimed immutable obligation.',
    `- Local \`origin\` was repointed to \`${attacker}\`.`,
    '- Local state ref, kernel source, and fake SQLite cache were modified.',
    `- Attempt to rewrite canonical project authority returned HTTP \`${attemptedAuthorityRewrite.status}\`.`,
    '- Canonical authority remained at the original claim commit.',
    `- Authorized effect coordinate: commit status \`${snapshot.postcondition.context}\` on \`${snapshot.postcondition.commit_sha}\`.`,
    '- The GitHub token is repository-scoped for commit-status writes; it is not capability-scoped to that one coordinate.',
    '- 100 newer distractor statuses were written so trusted readback must paginate before proving presence/absence.',
    '- Agent A now terminates without settlement.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id: snapshot.id,
  run_id: snapshot.run_id,
  immutable_revision: snapshot.revision,
  local_origin_after_tamper: attacker,
  authority_rewrite_status: attemptedAuthorityRewrite.status,
  provider_repository_id: snapshot.postcondition.repository_id,
  exact_input: snapshot.postcondition.commit_sha,
  context: snapshot.postcondition.context,
}));

process.exit(86);
