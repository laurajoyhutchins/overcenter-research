import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSourceClaim,
  SOURCE_CANDIDATE_SCHEMA,
  SOURCE_PROPOSAL_SCHEMA,
  SOURCE_TASK_SCHEMA,
  validateSourceCandidate,
  validateSourceProposal,
  validateSourceTaskPacket,
} from '../src/source/source-obligation.ts';

const packet = {
  schema: SOURCE_TASK_SCHEMA,
  kind: 'source-change',
  objective: 'Seal provider mutation behind EffectAuthority.',
  writable_paths: ['src/providers/github/status-effect.ts', 'src/authority/engine.ts'],
} as const;

test('source task contains semantic work but no claim-time source revision', () => {
  const validated = validateSourceTaskPacket(packet);
  assert.equal(JSON.stringify(validated).includes('source_sha'), false);
  assert.equal(JSON.stringify(validated).includes('base_sha'), false);
  assert.equal(JSON.stringify(validated).includes('acceptance'), false);
});

test('source task canonicalizes writable path ordering without defining a shadow obligation key', () => {
  const reordered = {
    ...packet,
    writable_paths: [...packet.writable_paths].reverse(),
  };

  assert.deepEqual(validateSourceTaskPacket(packet), validateSourceTaskPacket(reordered));
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
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        writable_paths: ['src\\\\..\\\\escape.ts'],
      }),
    /SOURCE_TASK_WRITABLE_PATH_INVALID/,
  );
  assert.throws(
    () =>
      validateSourceTaskPacket({
        ...packet,
        writable_paths: ['C:/src/a.ts'],
      }),
    /SOURCE_TASK_WRITABLE_PATH_INVALID/,
  );
  for (const path of ['.overcenter/project-intent.json', '.github/workflows/evil.yml']) {
    assert.throws(
      () =>
        validateSourceTaskPacket({
          ...packet,
          writable_paths: [path],
        }),
      /SOURCE_TASK_WRITABLE_PATH_INVALID/,
    );
  }
});

test('source proposal is claim-bound and cannot widen writable scope', () => {
  const claim = bindSourceClaim('kernel-semantic-key', 'run-7', 'authority-head', 'c'.repeat(40));
  const proposal = {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    files: [
      {
        path: 'src/authority/engine.ts',
        content_base64: Buffer.from('replacement\n').toString('base64'),
      },
    ],
  };

  assert.deepEqual(validateSourceProposal(proposal, packet, claim), proposal);
  assert.throws(
    () =>
      validateSourceProposal(
        {
          ...proposal,
          files: [{ path: 'README.md', content_base64: Buffer.from('widened').toString('base64') }],
        },
        packet,
        claim,
      ),
    /SOURCE_PROPOSAL_SCOPE_VIOLATION:README\.md/,
  );
  assert.throws(
    () => validateSourceProposal({ ...proposal, run_id: 'other-run' }, packet, claim),
    /SOURCE_PROPOSAL_RUN_MISMATCH/,
  );
  assert.throws(
    () =>
      validateSourceProposal(
        {
          ...proposal,
          files: [
            {
              path: '.github/workflows/evil.yml',
              content_base64: Buffer.from('name: evil').toString('base64'),
            },
          ],
        },
        packet,
        claim,
      ),
    /SOURCE_PROPOSAL_PATH_INVALID:0/,
  );
  assert.throws(
    () =>
      validateSourceProposal(
        {
          ...proposal,
          files: [{ path: 'src/authority/engine.ts', content_base64: '***not-base64***' }],
        },
        packet,
        claim,
      ),
    /SOURCE_PROPOSAL_CONTENT_INVALID:0/,
  );
});

test('claim-time source revision is separate from the kernel obligation key', () => {
  const obligationKey = 'kernel-semantic-key';
  const first = bindSourceClaim(obligationKey, 'run-1', 'authority-a', 'a'.repeat(40));
  const second = bindSourceClaim(obligationKey, 'run-2', 'authority-b', 'b'.repeat(40));

  assert.equal(first.obligation_key, second.obligation_key);
  assert.notEqual(first.source_sha, second.source_sha);
});

test('source candidate is bound to exact obligation, run, authority revision, and source SHA', () => {
  const obligationKey = 'kernel-semantic-key';
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
    () => validateSourceCandidate({ ...candidate, obligation_key: 'other-key' }, claim),
    /SOURCE_CANDIDATE_OBLIGATION_MISMATCH/,
  );
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
