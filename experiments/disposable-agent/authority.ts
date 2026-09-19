import { githubProofStateRef } from '../proof-environment.ts';
import { appendFileSync, writeFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { bindTaskSession } from '../../src/effect-broker.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path: string): Promise<any> {
  const token = required('GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return response.json();
}

const repository = required('GITHUB_REPOSITORY');
const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('SOURCE_SHA');
const stateRef = githubProofStateRef('disposable-agent');

const repositoryInfo = await github(`/repos/${repository}`);
if (!Number.isSafeInteger(repositoryInfo.id)) throw new Error('REPOSITORY_ID_UNAVAILABLE');

const proofId = `actions-trust-proof-${workflowRunId}-${workflowRunAttempt}`;
const context = `overcenter/trust-proof/${workflowRunId}/${workflowRunAttempt}`;
const acceptedWorkerResult = {
  kind: 'github-actions-worker-result/v1',
  obligation_id: proofId,
  source_sha: sourceSha,
};

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin', ref: stateRef });
kernel.initialize();

kernel.define({
  id: proofId,
  packet: {
    kind: 'github-actions-trust-boundary-proof/v1',
    executor: {
      provider: 'github-actions/v1',
      repository_id: repositoryInfo.id,
      workflow_run_id: workflowRunId,
      workflow_run_attempt: workflowRunAttempt,
      job: 'agent-a',
    },
    exact_input: {
      kind: 'git-commit/v1',
      repository_id: repositoryInfo.id,
      commit_sha: sourceSha,
    },
    effect: {
      kind: 'github-commit-status/v1',
      repository_id: repositoryInfo.id,
      commit_sha: sourceSha,
      context,
      state: 'success',
    },
  },
  postcondition: {
    verifier: 'github-commit-status/v1',
    provider: 'github',
    repository_id: repositoryInfo.id,
    commit_sha: sourceSha,
    context,
    expected_state: 'success',
  },
  effect_authority: githubCommitStatusEffectAuthority(),
  result_acceptance: {
    verifier: 'canonical-json-sha256/v1',
    expected_sha256: canonicalDigest(acceptedWorkerResult),
  },
});

const work = kernel.inspect().find(candidate => candidate.id === proofId);
if (!work) throw new Error('PROOF_OBLIGATION_MISSING');
const run = kernel.claim(work.id, work.revision);
const executing = kernel.inspect().find(candidate => candidate.id === proofId);
if (!executing) throw new Error('EXECUTING_OBLIGATION_MISSING');
const session = bindTaskSession(executing);
writeFileSync('task-session.json', `${JSON.stringify(session, null, 2)}\n`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Trusted project authority',
    '',
    `- Repository ID: \`${repositoryInfo.id}\``,
    `- Obligation: \`${proofId}\``,
    `- Exact input: \`${sourceSha}\``,
    `- Authority ref: \`${stateRef}\``,
    `- Claim commit: \`${run.claim_commit}\``,
    `- Run: \`${run.id}\``,
    `- Dispatch session generation: \`${session.execution_generation}\``,
    `- Dispatch authority commit: \`${session.execution_authority_commit}\``,
    '- The disposable executor has not started yet.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id: proofId,
  repository_id: repositoryInfo.id,
  exact_input: sourceSha,
  run_id: run.id,
  claim_commit: run.claim_commit,
  task_session: session,
  result_acceptance: executing.result_acceptance,
  effect_authority: executing.effect_authority,
  verifier: work.postcondition,
}));
