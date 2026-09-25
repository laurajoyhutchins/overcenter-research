import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as effectAdapter from '../src/effect-adapter.ts';
import {
  EFFECT_ADAPTER_CAPABILITIES,
  EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
  KUBERNETES_CONFIGMAP_EFFECT,
  effectAdapterCapabilities,
  validateEffectAdapterCapabilities,
  type EffectAdapterCapabilities,
} from '../src/effect-adapter.ts';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/authority/facts.ts';
import { projectReceipt } from '../src/authority/replay.ts';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { localFileEnoentEvidence } from '../src/observation/evidence.ts';
import type { Obligation } from '../src/model.ts';

test('effect adapter capabilities are closed machine-readable data', () => {
  assert.equal(EFFECT_ADAPTER_CAPABILITIES.length, 3);
  assert.doesNotThrow(() => JSON.stringify(EFFECT_ADAPTER_CAPABILITIES));

  for (const capabilities of EFFECT_ADAPTER_CAPABILITIES) {
    assert.equal(capabilities.schema, EFFECT_ADAPTER_CAPABILITIES_SCHEMA);
    assert.doesNotThrow(() => validateEffectAdapterCapabilities(capabilities));
  }

  assert.deepEqual(
    EFFECT_ADAPTER_CAPABILITIES.map((candidate) => candidate.effect_contract).sort(),
    [
      GITHUB_COMMIT_STATUS_EFFECT,
      GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
      KUBERNETES_CONFIGMAP_EFFECT,
    ].sort(),
  );
});

test('reservation release public API requires a validated witness', () => {
  assert.equal('reservedEffectReleaseSafe' in effectAdapter, false);
  assert.equal(typeof effectAdapter.reservedEffectReleaseWitnessSafe, 'function');
});

test('current production mutation adapters do not claim replay safety they cannot prove', () => {
  for (const effectContract of [
    GITHUB_COMMIT_STATUS_EFFECT,
    GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    KUBERNETES_CONFIGMAP_EFFECT,
  ]) {
    const capabilities = effectAdapterCapabilities(effectContract);
    assert.ok(capabilities);
    assert.equal(capabilities.duplicate_delivery, 'may-duplicate');
    assert.equal(capabilities.replay.kind, 'forbidden');
  }
});

test('replay capability requires terminal evidence and duplicate-effect protection', () => {
  const base: EffectAdapterCapabilities = {
    schema: EFFECT_ADAPTER_CAPABILITIES_SCHEMA,
    effect_contract: 'test/effect',
    postcondition_verifier: 'file-content-equals/v1',
    duplicate_delivery: 'semantically-idempotent',
    replay: {
      kind: 'terminal-absence',
      terminal_absence_evidence_kinds: ['test-terminal-absence'],
    },
    reservation_release: {
      kind: 'forbidden',
      reason: 'test adapter has no trusted pre-dispatch witness',
    },
  };
  assert.doesNotThrow(() => validateEffectAdapterCapabilities(base));

  assert.throws(
    () =>
      validateEffectAdapterCapabilities({
        ...base,
        duplicate_delivery: 'may-duplicate',
      }),
    /REPLAY_CAPABILITY_REQUIRES_DUPLICATE_EFFECT_PROTECTION/,
  );
  assert.throws(
    () =>
      validateEffectAdapterCapabilities({
        ...base,
        replay: { kind: 'terminal-absence', terminal_absence_evidence_kinds: [] },
      }),
    /REPLAY_CAPABILITY_REQUIRES_TERMINAL_EVIDENCE/,
  );
});

test('authoritative absence alone cannot reopen a run with an unresolved effect', () => {
  const path = '/provider/result';
  const work: Obligation = {
    id: 'effectful-file',
    dependencies: [],
    packet: { effect_contract: 'unregistered/effect' },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path,
      content: 'expected',
    },
  };
  const fact: ReceiptFact = {
    schema: RECEIPT_SCHEMA,
    run_id: 'run-1',
    obligation_id: work.id,
    claimed_revision: 'revision-1',
    claim_commit: 'claim-1',
    execution_generation: 1,
    execution_authority_commit: 'authority-1',
    kind: 'observation',
    observed: {
      verifier: 'file-content-equals/v1',
      path,
      expected_sha256: '0'.repeat(64),
      mutation_certainty: 'absent',
      absence_evidence: localFileEnoentEvidence(path),
    },
    settled_at: '2026-09-23T00:00:00.000Z',
  };

  assert.equal(projectReceipt(fact, work).disposition, 'READY');
  assert.equal(projectReceipt(fact, work, undefined, true).disposition, 'RECOVERY_REQUIRED');
});

test('reserved-effect absence remains recovery-required across durable replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'effect-replay-capability-'));
  const database = join(root, 'overcenter.sqlite');
  const target = join(root, 'missing.txt');
  const options = {
    observationContext: { localFileRoot: root },
  };
  const kernel = new OvercenterKernel(database, options);
  try {
    kernel.initialize();
    kernel.define({
      id: 'effectful-file',
      packet: { effect_contract: 'unregistered/effect' },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: target,
        content: 'expected',
      },
    });
    const work = kernel.deriveReadyWork();
    assert.ok(work);
    const run = kernel.claim(work.id, work.revision);
    kernel.beginEffect(run);

    const receipt = kernel.resolve(run);
    assert.equal(receipt.observed?.mutation_certainty, 'absent');
    assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    kernel.close();

    const reopened = new OvercenterKernel(database, options);
    try {
      assert.equal(reopened.inspect()[0].status, 'RECOVERY_REQUIRED');
      assert.equal(reopened.hasUnresolvedEffect(run.id), true);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      kernel.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes ConfigMap mutation keeps replay and reservation release closed', () => {
  const capabilities = effectAdapterCapabilities(KUBERNETES_CONFIGMAP_EFFECT);
  assert.ok(capabilities);
  assert.equal(capabilities.postcondition_verifier, 'kubernetes-configmap-exists/v1');
  assert.equal(capabilities.replay.kind, 'forbidden');
  assert.equal(capabilities.reservation_release.kind, 'forbidden');
});
