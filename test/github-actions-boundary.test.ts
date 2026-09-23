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
const candidateOnlyWorkflowPaths = [
  '../.github/workflows/assignment-capsule-proof.yml',
  '../.github/workflows/disposable-agent-proof.yml',
  '../.github/workflows/formal-kernel.yml',
  '../.github/workflows/github-object-transport-proof.yml',
  '../.github/workflows/github-observation-grammar.yml',
  '../.github/workflows/production-latency.yml',
  '../.github/workflows/typebox-production-contract.yml',
];

function job(name: string, next: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${next}:\n`, start + 1);
  assert.notEqual(start, -1, `missing job ${name}`);
  assert.notEqual(end, -1, `missing following job ${next}`);
  return workflow.slice(start, end);
}

function eventBlock(source: string, event: string): string {
  const marker = `  ${event}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${event} trigger`);
  const after = source.slice(start + marker.length);
  const next = after.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/);
  return next === -1 ? after : after.slice(0, next);
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

  assert.doesNotMatch(
    worker,
    /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i,
  );
  assert.doesNotMatch(
    broker,
    /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i,
  );
});

test('active hosted proof contains no legacy commit-status effect intent', () => {
  const paths = [
    '../experiments/disposable-agent/authority.ts',
    '../experiments/disposable-agent/agent-a.ts',
    '../experiments/disposable-agent/effect-broker.ts',
  ];

  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /github-commit-status\/v1/);
    assert.doesNotMatch(source, /overcenter-effect-intent-v1/);
  }
});

test('intermediate PR heads cannot spend candidate-only CI evidence', () => {
  assert.match(
    eventBlock(mergeGate, 'pull_request'),
    /types: \[opened, synchronize, reopened\]/,
    'ordinary PR transitions must stay cheap and non-certifying',
  );
  assert.doesNotMatch(
    mergeGate,
    /github\.event_name == 'pull_request' && github\.event\.action == 'ready_for_review'/,
    'Ready for review must not be a merge-certification capability',
  );
  assert.match(
    mergeGate,
    /expensive: \$\{\{ github\.event_name == 'push' \|\| github\.run_attempt > 1 \}\}/,
    'only main push or an explicit rerun may spend canonical candidate evidence',
  );
  assert.doesNotMatch(
    mergeGate,
    /workflow_dispatch:/,
    'merge certification must not require a second dispatch surface',
  );
  assert.match(
    mergeGate,
    /group: merge-gate-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
    'all attempts for one exact PR head must share one concurrency key',
  );
  assert.match(
    mergeGate,
    /name: \$\{\{ github\.event_name == 'pull_request' && github\.run_attempt == 1 && 'PR preflight' \|\| 'Merge gate' \}\}/,
    'attempt one is preflight and a rerun becomes the exact-head Merge gate',
  );
  assert.match(
    mergeGate,
    /PR preflight only; rerun Certify candidate to spend exact-head merge evidence/,
    'ordinary PR runs must expose the existing evidence job as the certification gesture',
  );
  assert.doesNotMatch(
    mergeGate,
    /pull_request\)[\s\S]{0,220}exit 1/,
    'ordinary PR preflight must not leave a stale failed Merge gate on the certified SHA',
  );
  assert.match(
    evidenceWorkflow,
    /workflow_call:\n\s+inputs:\n\s+expensive:/,
    'the reusable evidence workflow must accept an explicit expensive-evidence capability',
  );
  assert.match(
    evidenceWorkflow,
    /evidence:\n\s+name: Candidate evidence/,
    'merge-gate evidence must share one full runner',
  );
  for (const command of [
    'npm run test:unit',
    'npm run test:experiments',
    'npm run proof:formal',
    'npm run proof:production-boundary',
    'scripts/proof-self-application.sh',
  ]) {
    assert.ok(evidenceWorkflow.includes(command), `candidate evidence is missing ${command}`);
  }
  assert.doesNotMatch(
    mergeGate,
    /production-computation:|self-application:/,
    'candidate-local evidence must not acquire dedicated merge-gate runners',
  );
});

test('standalone expensive workflows only run for candidate PR heads', () => {
  for (const path of candidateOnlyWorkflowPaths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(
      eventBlock(source, 'pull_request'),
      /types: \[ready_for_review\]/,
      `${path} must not run expensive work on synchronize`,
    );
  }
});
