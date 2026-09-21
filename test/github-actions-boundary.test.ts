import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/disposable-agent-proof.yml', import.meta.url),
  'utf8',
);
const mergeGate = readFileSync(
  new URL('../.github/workflows/merge-gate.yml', import.meta.url),
  'utf8',
);
const evidenceWorkflow = readFileSync(
  new URL('../.github/workflows/tests.yml', import.meta.url),
  'utf8',
);

function job(name: string, next: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${next}:\n`, start + 1);
  assert.notEqual(start, -1, `missing job ${name}`);
  assert.notEqual(end, -1, `missing following job ${next}`);
  return workflow.slice(start, end);
}

test('GitHub Actions keeps provider write authority out of the disposable worker job', () => {
  const worker = job('agent-a', 'effect-broker');
  const broker = job('effect-broker', 'agent-b');

  assert.match(worker, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(worker, /statuses:\s*write/);
  assert.doesNotMatch(worker, /contents:\s*write/);

  assert.match(broker, /permissions:\n\s+contents: write\n\s+statuses: write\n/);
  assert.match(broker, /effect-broker\.ts/);
});

test('hosted proof does not transport worker-declared provider authority', () => {
  const worker = job('agent-a', 'effect-broker');
  const broker = job('effect-broker', 'agent-b');

  assert.doesNotMatch(worker, /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i);
  assert.doesNotMatch(broker, /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i);
});

test('active hosted proof contains no legacy commit-status effect intent', () => {
  const paths = [
    '../experiments/disposable-agent/authority.ts',
    '../experiments/disposable-agent/agent-a.ts',
    '../experiments/disposable-agent/effect-broker.ts',
    '../experiments/two-effect-concurrency/authority.ts',
    '../experiments/two-effect-concurrency/agent.ts',
  ];

  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /github-commit-status\/v1/);
    assert.doesNotMatch(source, /overcenter-effect-intent-v1/);
  }
});

test('intermediate PR heads cannot spend candidate-only CI evidence', () => {
  assert.match(
    mergeGate,
    /workflow_dispatch:\n\s+inputs:\n\s+candidate:/,
    'merge gate must expose an explicit candidate dispatch',
  );
  assert.match(
    mergeGate,
    /source_sha:/,
    'candidate dispatch must carry the exact expected source SHA',
  );
  assert.match(
    mergeGate,
    /test "\$REQUESTED_SOURCE_SHA" = "\$SOURCE_SHA"/,
    'candidate dispatch must fail closed when the selected ref moved',
  );
  assert.match(
    mergeGate,
    /github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.candidate\)/,
    'expensive merge-gate jobs must not be enabled by pull_request events',
  );
  assert.match(
    mergeGate,
    /pull_request\)\n[\s\S]*?Exact-head candidate evidence is required[\s\S]*?exit 1/,
    'ordinary pull_request runs must remain non-mergeable until candidate evidence runs',
  );
  assert.match(
    evidenceWorkflow,
    /workflow_call:\n\s+inputs:\n\s+expensive:/,
    'the reusable evidence workflow must accept an explicit expensive-evidence capability',
  );
  assert.match(
    evidenceWorkflow,
    /proofs:\n\s+name: Adversarial, experimental, and formal proofs\n\s+if: \$\{\{ inputs\.expensive \}\}/,
    'proofs must be skipped unless the caller explicitly enables candidate evidence',
  );
});
