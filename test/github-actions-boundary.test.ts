import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/disposable-agent-proof.yml', import.meta.url),
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

test('trusted dispatch session and untrusted worker result travel separately', () => {
  const authority = job('project-authority', 'agent-a');
  const worker = job('agent-a', 'effect-broker');
  const broker = job('effect-broker', 'agent-b');

  assert.match(authority, /Upload trusted dispatch session/);
  assert.match(authority, /disposable-agent-task-session/);
  assert.match(authority, /task-session\.json/);

  assert.match(worker, /Upload candidate worker result/);
  assert.match(worker, /disposable-agent-worker-result/);
  assert.match(worker, /worker-result\.json/);
  assert.doesNotMatch(worker, /task-session\.json/);

  assert.match(broker, /Download trusted dispatch session/);
  assert.match(broker, /Download candidate worker result/);
  assert.match(broker, /disposable-agent-task-session/);
  assert.match(broker, /disposable-agent-worker-result/);
});
