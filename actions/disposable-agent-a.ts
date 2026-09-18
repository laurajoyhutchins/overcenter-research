import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const repository = required('GITHUB_REPOSITORY');
const workflowRunId = required('GITHUB_RUN_ID');
const workflowRunAttempt = required('GITHUB_RUN_ATTEMPT');
const sourceSha = required('GITHUB_SHA');
const proofId = `actions-proof-${workflowRunId}-${workflowRunAttempt}`;
const effectRef = `refs/tags/overcenter-actions-effect-${workflowRunId}-${workflowRunAttempt}`;

const kernel = new GitOvercenterKernel(process.cwd(), { remote: 'origin' });
kernel.initialize();

kernel.define({
  id: proofId,
  packet: {
    kind: 'github-actions-disposable-proof/v1',
    executor: {
      provider: 'github-actions/v1',
      repository,
      workflow_run_id: workflowRunId,
      workflow_run_attempt: workflowRunAttempt,
      job: 'agent-a',
    },
    effect: {
      kind: 'git-create-ref/v1',
      remote: 'origin',
      ref: effectRef,
      target_sha: sourceSha,
    },
  },
  postcondition: {
    verifier: 'git-ref-equals/v1',
    remote: 'origin',
    ref: effectRef,
    target_sha: sourceSha,
  },
});

const work = kernel.inspect().find(candidate => candidate.id === proofId);
if (!work) throw new Error('PROOF_OBLIGATION_MISSING');
const run = kernel.claim(work.id, work.revision);

execFileSync('git', ['push', '--porcelain', 'origin', `${sourceSha}:${effectRef}`], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const observed = execFileSync('git', ['ls-remote', 'origin', effectRef], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
if (!observed.startsWith(`${sourceSha}\t`)) {
  throw new Error(`EFFECT_READBACK_MISMATCH: ${observed}`);
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, [
    '## Agent A',
    '',
    `- Overcenter run: \`${run.id}\``,
    `- Claim commit: \`${run.claim_commit}\``,
    `- External effect: \`${effectRef} -> ${sourceSha}\``,
    '- The effect was read back from GitHub.',
    '- Agent A now terminates **without settlement**.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  proof_id: proofId,
  overcenter_run_id: run.id,
  claim_commit: run.claim_commit,
  effect_ref: effectRef,
  target_sha: sourceSha,
}));

// Deliberate agent-process death after the provider effect.
// The workflow supervisor observes this failed step; no Agent A state is passed to Agent B.
process.exit(86);
