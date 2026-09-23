import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSourceClaim,
  SOURCE_CANDIDATE_SCHEMA,
  SOURCE_TASK_SCHEMA,
  sourceTaskDigest,
  validateSourceCandidate,
  validateSourceTaskPacket,
} from '../src/source/source-obligation.ts';

const packet = {
  schema: SOURCE_TASK_SCHEMA,
  kind: 'source-change',
  objective: 'Seal provider mutation behind EffectAuthority.',
  writable_paths: ['src/providers/github/status-effect.ts', 'src/authority/engine.ts'],
  acceptance: [
    {
      verifier: 'file-content-equals/v1',
      path: 'src/authority/policy.txt',
      content: 'sealed\n',
    },
    {
      verifier: 'file-content-equals/v1',
      path: 'src/providers/github/policy.txt',
      content: 'broker-only\n',
    },
  ],
} as const;

test('source task semantic identity excludes claim-time source revision', () => {
  const validated = validateSourceTaskPacket(packet);
  const digest = sourceTaskDigest(validated);

  const first = bindSourceClaim(digest, 'run-1', 'authority-a', 'a'.repeat(40));
  const second = bindSourceClaim(digest, 'run-2', 'authority-b', 'b'.repeat(40));

  assert.equal(first.obligation_key, second.obligation_key);
  assert.notEqual(first.source_sha, second.source_sha);
  assert.equal(JSON.stringify(validated).includes('source_sha'), false);
  assert.equal(JSON.stringify(validated).includes('base_sha'), false);
});

test('source task digest is canonical across path and acceptance ordering', () => {
  const reordered = {
    ...packet,
    writable_paths: [...packet.writable_paths].reverse(),
    acceptance: [...packet.acceptance].reverse(),
  };

  assert.equal(sourceTaskDigest(packet), sourceTaskDigest(reordered));
});

test('source task rejects duplicate and unsafe repository paths', () => {
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        writable_paths: ['src/a.ts', 'src/a.ts'],
      }),
    /SOURCE_TASK_WRITABLE_PATH_DUPLICATE/,
  );
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        writable_paths: ['../escape.ts'],
      }),
    /SOURCE_TASK_WRITABLE_PATH_INVALID/,
  );
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        writable_paths: ['.git/config'],
      }),
    /SOURCE_TASK_WRITABLE_PATH_INVALID/,
  );
});

test('source candidate is bound to exact obligation, run, authority revision, and source SHA', () => {
  const obligationKey = sourceTaskDigest(packet);
  const claim = bindSourceClaim(obligationKey, 'run-7', 'authority-head', 'c'.repeat(40));
  const candidate = {
    schema: SOURCE_CANDIDATE_SCHEMA,
    obligation_key: obligationKey,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    commit_sha: 'd'.repeat(40),
  };

  assert.deepEqual(validateSourceCandidate(candidate, claim), candidate);

  assert.throws(
    () => validateSourceCandidate({ ...candidate, run_id: 'run-8' }, claim),
    /SOURCE_CANDIDATE_RUN_MISMATCH/,
  );
  assert.throws(
    () => validateSourceCandidate({ ...candidate, claimed_revision: 'stale' }, claim),
    /SOURCE_CANDIDATE_REVISION_MISMATCH/,
  );
  assert.throws(
    () => validateSourceCandidate({ ...candidate, claimed_source_sha: 'e'.repeat(40) }, claim),
    /SOURCE_CANDIDATE_SOURCE_MISMATCH/,
  );
});

test('source acceptance remains deliberately narrow in the first production contract', () => {
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        acceptance: [{ verifier: 'command-exits-zero/v1', path: 'package.json', content: '' }],
      }),
    /SOURCE_TASK_ACCEPTANCE_VERIFIER_UNSUPPORTED/,
  );
});
