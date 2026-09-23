import assert from 'node:assert/strict';
import test from 'node:test';

import { GITHUB_COMMIT_STATUS_EFFECT } from '../src/effect-adapter.ts';
import { semanticEffects } from '../src/providers/semantic-registry.ts';
import {
  SEMANTIC_COMMAND_SCHEMA,
  SEMANTIC_COMMAND_SCHEMA_VERSION,
} from '../src/semantic-command.ts';

const COMMIT = 'a'.repeat(40);

function command() {
  return {
    schema: SEMANTIC_COMMAND_SCHEMA,
    schema_version: SEMANTIC_COMMAND_SCHEMA_VERSION,
    kind: 'ensure',
    id: 'status-proof',
    resource: 'github.commit-status',
    target: {
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: 'overcenter/proof',
    },
    desired: { state: 'success' },
  } as const;
}

test('agent-shaped ensure command compiles through the closed semantic registry', () => {
  assert.deepEqual(semanticEffects.resources(), ['github.commit-status']);

  const obligation = semanticEffects.compile(command());
  assert.equal(obligation.id, 'status-proof');
  assert.equal(obligation.packet?.effect_contract, GITHUB_COMMIT_STATUS_EFFECT);
  assert.deepEqual(obligation.packet?.semantic_intent, {
    schema: 'overcenter-semantic-effect-intent',
    schema_version: 1,
    kind: 'ensure',
    resource: 'github.commit-status',
    target: command().target,
    desired: command().desired,
  });
  assert.deepEqual(obligation.postcondition, {
    verifier: 'github-commit-status/v2',
    provider: 'github',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    commit_sha: COMMIT,
    context: 'overcenter/proof',
    expected_state: 'success',
  });
});

test('agent command cannot name an unregistered resource', () => {
  assert.throws(
    () =>
      semanticEffects.compile({
        ...command(),
        resource: 'github.raw-request',
      }),
    /SEMANTIC_COMMAND_RESOURCE_UNREGISTERED/,
  );
});

test('agent command shape is closed and versioned outside the schema name', () => {
  assert.throws(
    () =>
      semanticEffects.compile({
        ...command(),
        retry: true,
      }),
    /SEMANTIC_COMMAND_INVALID:UNKNOWN_FIELD:retry/,
  );
  assert.throws(
    () =>
      semanticEffects.compile({
        ...command(),
        schema_version: 999,
      }),
    /SEMANTIC_COMMAND_SCHEMA_VERSION_UNSUPPORTED/,
  );
});

test('agent command has no retry, settlement, reservation, or authority controls', () => {
  const serialized = JSON.stringify(command());
  for (const forbidden of [
    'retry',
    'settlement',
    'reservation',
    'execution_capability',
    'effect_authority',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
