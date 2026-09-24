import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel, type GeneratedOutputValidator } from '../src/authority/kernel.ts';
import { FileEvidenceStore } from '../src/evidence/file-store.ts';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';

const VALIDATOR = 'source-proposal-scope/v1';

const sourceProposalValidator: GeneratedOutputValidator = (bytes, work) => {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SOURCE_PROPOSAL_INVALID');
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('SOURCE_PROPOSAL_FILES_INVALID');
  }
  const allowed = work.packet.writable_paths;
  if (!Array.isArray(allowed) || !allowed.every((path) => typeof path === 'string')) {
    throw new Error('SOURCE_PROPOSAL_SCOPE_INVALID');
  }

  const changedPaths: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('SOURCE_PROPOSAL_FILE_INVALID');
    }
    const path = (file as { path?: unknown }).path;
    const content = (file as { content?: unknown }).content;
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error('SOURCE_PROPOSAL_FILE_INVALID');
    }
    if (!allowed.includes(path)) throw new Error('SOURCE_PROPOSAL_SCOPE_VIOLATION');
    changedPaths.push(path);
  }
  changedPaths.sort();
  return {
    changed_paths: changedPaths,
    byte_length: bytes.byteLength,
  };
};

const sourceOutput = (content: string) =>
  Buffer.from(
    JSON.stringify({
      files: [{ path: 'src/feature.ts', content }],
    }),
    'utf8',
  );

function defineGraph(kernel: OvercenterKernel, finalPath: string): void {
  kernel.define({
    id: 'source-proposal',
    packet: {
      kind: 'source-change',
      writable_paths: ['src/feature.ts'],
    },
    postcondition: {
      verifier: 'verified-generated-output/v1',
      validator: VALIDATOR,
    },
  });
  kernel.define({
    id: 'source-integration',
    dependencies: [
      {
        kind: 'semantic',
        upstream: 'source-proposal',
        consumes: { kind: 'evidence', selector: 'settlement-receipt' },
      },
    ],
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: finalPath,
      content: 'integrated\n',
    },
  });
}

test('verified generated output settles from retained bytes and unlocks downstream identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-output-'));
  try {
    const database = join(root, 'authority.sqlite');
    const evidence = new FileEvidenceStore(join(root, 'evidence'));
    const kernel = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      kernel.initialize();
      defineGraph(kernel, join(root, 'integrated.txt'));

      const ready = kernel.deriveReadyWork();
      assert.equal(ready?.id, 'source-proposal');
      const permit = kernel.claim(ready!.id, ready!.revision);
      const receipt = kernel.settleVerifiedOutput(permit, sourceOutput('export const x = 1;\n'));

      assert.equal(receipt.kind, 'verified-output');
      assert.equal(receipt.disposition, 'DONE');
      assert.equal(receipt.verified, true);
      assert.equal(receipt.verified_output?.validator, VALIDATOR);
      assert.deepEqual(receipt.verified_output?.metadata, {
        changed_paths: ['src/feature.ts'],
        byte_length: sourceOutput('export const x = 1;\n').byteLength,
      });
      assert.deepEqual(
        evidence.get(receipt.verified_output!.evidence),
        sourceOutput('export const x = 1;\n'),
      );

      const work = kernel.inspect();
      assert.equal(work.find((item) => item.id === 'source-proposal')?.status, 'DONE');
      assert.equal(work.find((item) => item.id === 'source-integration')?.status, 'READY');
      assert.equal(kernel.deriveReadyWork()?.id, 'source-integration');

      const downstream = kernel.explain('source-integration');
      assert.equal(downstream.status, 'READY');
      if (downstream.status !== 'READY') throw new Error('DOWNSTREAM_NOT_READY');
      assert.match(downstream.reason.semantic_key, /^[0-9a-f]{64}$/);
    } finally {
      kernel.close();
    }

    const reopened = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      assert.equal(
        reopened.inspect().find((item) => item.id === 'source-proposal')?.status,
        'DONE',
      );
      assert.equal(reopened.deriveReadyWork()?.id, 'source-integration');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing, corrupt, or differently validated retained output fails current reuse closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-output-reuse-'));
  try {
    const database = join(root, 'authority.sqlite');
    const evidence = new FileEvidenceStore(join(root, 'evidence'));
    let ref: NonNullable<
      ReturnType<OvercenterKernel['settleVerifiedOutput']>['verified_output']
    >['evidence'];

    const kernel = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      kernel.initialize();
      kernel.define({
        id: 'source-proposal',
        packet: {
          kind: 'source-change',
          writable_paths: ['src/feature.ts'],
        },
        postcondition: {
          verifier: 'verified-generated-output/v1',
          validator: VALIDATOR,
        },
      });
      const ready = kernel.deriveReadyWork()!;
      const permit = kernel.claim(ready.id, ready.revision);
      const receipt = kernel.settleVerifiedOutput(permit, sourceOutput('export const x = 2;\n'));
      ref = receipt.verified_output!.evidence;
      assert.equal(kernel.inspect()[0]?.status, 'DONE');
    } finally {
      kernel.close();
    }

    const noEvidence = new OvercenterKernel(database, {
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      assert.equal(noEvidence.inspect()[0]?.status, 'BLOCKED');
      const explanation = noEvidence.explain('source-proposal');
      assert.equal(explanation.status, 'BLOCKED');
      if (explanation.status !== 'BLOCKED') throw new Error('EXPECTED_BLOCKED');
      assert.equal(explanation.reason.kind, 'current-realization-indeterminate');
    } finally {
      noEvidence.close();
    }

    const drifted = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: {
        [VALIDATOR]: (bytes, work) => ({
          ...sourceProposalValidator(bytes, work),
          validator_revision: 'changed',
        }),
      },
    });
    try {
      assert.equal(drifted.inspect()[0]?.status, 'BLOCKED');
    } finally {
      drifted.close();
    }

    writeFileSync(evidence.pathFor(ref!), Buffer.from('corrupt'));
    const corrupt = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      assert.equal(corrupt.inspect()[0]?.status, 'BLOCKED');
    } finally {
      corrupt.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verified output settlement rejects stale authority, missing stores, and invalid scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-output-fences-'));
  try {
    const database = join(root, 'authority.sqlite');
    const evidence = new FileEvidenceStore(join(root, 'evidence'));
    const kernel = new OvercenterKernel(database, {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      kernel.initialize();
      kernel.define({
        id: 'source-proposal',
        packet: {
          kind: 'source-change',
          writable_paths: ['src/feature.ts'],
        },
        postcondition: {
          verifier: 'verified-generated-output/v1',
          validator: VALIDATOR,
        },
      });
      const ready = kernel.deriveReadyWork()!;
      const stale = kernel.claim(ready.id, ready.revision);
      const current = kernel.acquireExecution(stale.id);

      assert.throws(
        () => kernel.settleVerifiedOutput(stale, sourceOutput('stale\n')),
        /STALE_EXECUTION_GENERATION/,
      );
      assert.throws(
        () =>
          kernel.settleVerifiedOutput(
            current,
            Buffer.from(
              JSON.stringify({
                files: [{ path: 'src/undeclared.ts', content: 'hostile\n' }],
              }),
            ),
          ),
        /SOURCE_PROPOSAL_SCOPE_VIOLATION/,
      );
      const receipt = kernel.settleVerifiedOutput(current, sourceOutput('current\n'));
      assert.equal(receipt.disposition, 'DONE');
    } finally {
      kernel.close();
    }

    const noStoreDatabase = join(root, 'no-store.sqlite');
    const noStore = new OvercenterKernel(noStoreDatabase, {
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    });
    try {
      noStore.initialize();
      noStore.define({
        id: 'source-proposal',
        packet: { writable_paths: ['src/feature.ts'] },
        postcondition: {
          verifier: 'verified-generated-output/v1',
          validator: VALIDATOR,
        },
      });
      const ready = noStore.deriveReadyWork()!;
      const permit = noStore.claim(ready.id, ready.revision);
      assert.throws(
        () => noStore.settleVerifiedOutput(permit, sourceOutput('no-store\n')),
        /GENERATED_OUTPUT_EVIDENCE_STORE_UNAVAILABLE/,
      );
      assert.equal(noStore.inspect()[0]?.status, 'EXECUTING');
    } finally {
      noStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('Git authority round-trips the verified output fact and current evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-output-git-'));
  try {
    const repo = join(root, 'authority.git');
    execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
    const evidence = new FileEvidenceStore(join(root, 'evidence'));
    const options = {
      evidenceStore: evidence,
      generatedOutputValidators: { [VALIDATOR]: sourceProposalValidator },
    };

    const kernel = new GitOvercenterKernel(repo, options);
    kernel.initialize();
    kernel.define({
      id: 'source-proposal',
      packet: { writable_paths: ['src/feature.ts'] },
      postcondition: {
        verifier: 'verified-generated-output/v1',
        validator: VALIDATOR,
      },
    });
    const ready = kernel.deriveReadyWork()!;
    const permit = kernel.claim(ready.id, ready.revision);
    const receipt = kernel.settleVerifiedOutput(permit, sourceOutput('git-backed\n'));
    assert.equal(receipt.disposition, 'DONE');

    const persisted = JSON.parse(
      execFileSync(
        'git',
        ['-C', repo, 'show', `${receipt.settlement_commit}:verified-output.json`],
        { encoding: 'utf8' },
      ),
    ) as Record<string, unknown>;
    assert.equal(persisted.schema, 'overcenter-verified-output');
    assert.equal(persisted.validator, VALIDATOR);

    const reopened = new GitOvercenterKernel(repo, options);
    assert.equal(reopened.inspect()[0]?.status, 'DONE');
    assert.equal(reopened.receipts()[0]?.verified_output?.validator, VALIDATOR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
