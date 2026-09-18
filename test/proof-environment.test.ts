import assert from 'node:assert/strict';
import test from 'node:test';
import { githubProofStateRef } from '../experiments/proof-environment.ts';

test('proof authority ref is derived from proof and GitHub run identity', () => {
  assert.equal(
    githubProofStateRef('disposable-agent', { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3' }),
    'refs/overcenter/proofs/disposable-agent/42/3',
  );
});

test('proof authority ref rejects malformed identity', () => {
  assert.throws(() => githubProofStateRef('Disposable Agent', { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3' }), /GITHUB_PROOF_NAME_INVALID/);
  assert.throws(() => githubProofStateRef('disposable-agent', { GITHUB_RUN_ID: 'run-42', GITHUB_RUN_ATTEMPT: '3' }), /GITHUB_PROOF_RUN_IDENTITY_INVALID/);
  assert.throws(() => githubProofStateRef('disposable-agent', { GITHUB_RUN_ID: '42' }), /GITHUB_PROOF_ENV_REQUIRED:GITHUB_RUN_ATTEMPT/);
});
