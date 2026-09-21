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
const operatorCommands = readFileSync(
  new URL('../.github/workflows/operator-candidate-certify.yml', import.meta.url),
  'utf8',
);
const candidateOnlyWorkflowPaths = [
  '../.github/workflows/assignment-capsule-proof.yml',
  '../.github/workflows/conflicting-effect.yml',
  '../.github/workflows/datalog-projection.yml',
  '../.github/workflows/disposable-agent-proof.yml',
  '../.github/workflows/formal-kernel.yml',
  '../.github/workflows/github-object-transport-proof.yml',
  '../.github/workflows/github-observation-grammar.yml',
  '../.github/workflows/kubernetes-observation-semantics.yml',
  '../.github/workflows/lean-semantic-oracle.yml',
  '../.github/workflows/linkml-contract-refactor.yml',
  '../.github/workflows/linkml-ontology.yml',
  '../.github/workflows/production-criticality-mutation-probe.yml',
  '../.github/workflows/production-criticality-ranking.yml',
  '../.github/workflows/production-latency.yml',
  '../.github/workflows/projection-comparison.yml',
  '../.github/workflows/scheduler-bottleneck.yml',
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
    eventBlock(mergeGate, 'pull_request'),
    /types: \[opened, synchronize, reopened, ready_for_review\]/,
    'merge gate must observe the exact Ready for review candidate transition',
  );
  assert.match(
    mergeGate,
    /github\.event_name == 'pull_request' && github\.event\.action == 'ready_for_review'/,
    'expensive merge-gate jobs must require the candidate transition on pull requests',
  );
  assert.match(
    mergeGate,
    /source_sha:/,
    'manual candidate dispatch must carry the exact expected source SHA',
  );
  assert.match(
    mergeGate,
    /test "\$REQUESTED_SOURCE_SHA" = "\$SOURCE_SHA"/,
    'manual candidate dispatch must fail closed when the selected ref moved',
  );
  assert.match(
    mergeGate,
    /Exact-head candidate evidence is required[\s\S]*?Ready for review[\s\S]*?exit 1/,
    'ordinary pull_request runs must remain non-mergeable until candidate evidence runs',
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
    'npm run test:stress',
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

test('operator commands expose isolated trusted rerun anchors without a public command mailbox', () => {
  assert.match(
    eventBlock(operatorCommands, 'pull_request_target'),
    /types: \[opened, synchronize, reopened\]/,
    'operator commands must materialize once per PR head from trusted base code',
  );
  assert.doesNotMatch(
    operatorCommands,
    /issue_comment:|pull_request_review:|label:/,
    'operator commands must not use public discussion or labels as transport',
  );
  assert.match(
    operatorCommands,
    /^name: Overcenter command · candidate\.certify/m,
    'one workflow must represent one stable semantic command',
  );
  assert.match(
    operatorCommands,
    /command:\n\s+name: candidate\.certify/,
    'the command workflow must expose one rerunnable command job',
  );
  assert.match(
    operatorCommands,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    'cross-repository PR heads must not acquire command authority',
  );
  assert.match(
    operatorCommands,
    /permissions:\n\s+actions: write\n\s+contents: read/,
    'the command anchor may write Actions state but not repository content',
  );
  assert.match(
    operatorCommands,
    /if: \$\{\{ github\.run_attempt == 1 \}\}[\s\S]*state: available/,
    'the first command run must advertise availability without invoking',
  );
  assert.match(
    operatorCommands,
    /COMMAND_IMPLEMENTATION_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    'privileged command code must be pinned to the trusted base revision',
  );
  assert.match(
    operatorCommands,
    /Check out trusted command implementation[\s\S]*ref: \$\{\{ env\.COMMAND_IMPLEMENTATION_SHA \}\}/,
    'invocation must never execute pull-request source with the write token',
  );
  assert.match(
    operatorCommands,
    /github-operator-command\.ts candidate\.certify/,
    'workflow YAML must delegate command semantics to deterministic software',
  );
});
