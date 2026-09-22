import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const TASK_PACKET = Object.freeze({
  action: 'produce-provider-marker',
  content: 'present',
});

type AmbientCapabilities = {
  providerWrite?: (content: string) => void;
};

function packetBytes(packet: unknown): string {
  return JSON.stringify(packet);
}

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runUntrustedWorker(
  packet: typeof TASK_PACKET,
  ambient: AmbientCapabilities,
) {
  const bytes = packetBytes(packet);
  let providerEffectAttempted = false;

  if (ambient.providerWrite) {
    providerEffectAttempted = true;
    ambient.providerWrite(packet.content);
  }

  return {
    packet_bytes: bytes,
    packet_sha256: digest(bytes),
    provider_effect_attempted: providerEffectAttempted,
    declared_disposition: 'DONE',
    declared_verified: true,
    declared_settlement_commit: 'worker-forged',
  } as const;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-ambient-authority-'));
  const authority = join(root, 'authority.git');
  const world = join(root, 'provider-truth.txt');

  execFileSync('git', ['init', '--bare', authority], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(authority);
  kernel.initialize();
  kernel.define({
    id: 'effect',
    packet: { ...TASK_PACKET },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: world,
      content: TASK_PACKET.content,
    },
  });

  const work = kernel.deriveReadyWork()!;
  const run = kernel.claim(work.id, work.revision);
  kernel.beginEffect(run);
  assert.equal(kernel.inspect()[0].status, 'EXECUTING');

  return { root, world, kernel, work, run };
}

test('ambient provider authority bypasses effect confinement but not Overcenter settlement authority', () => {
  const controlled = fixture();
  const overCapable = fixture();

  try {
    assert.equal(packetBytes(controlled.work.packet), packetBytes(overCapable.work.packet));

    const controlledResult = runUntrustedWorker(
      controlled.work.packet as typeof TASK_PACKET,
      {},
    );
    const overCapableResult = runUntrustedWorker(
      overCapable.work.packet as typeof TASK_PACKET,
      {
        providerWrite(content) {
          writeFileSync(overCapable.world, content);
        },
      },
    );

    assert.equal(controlledResult.packet_sha256, overCapableResult.packet_sha256);
    assert.equal(controlledResult.provider_effect_attempted, false);
    assert.equal(overCapableResult.provider_effect_attempted, true);

    assert.equal(existsSync(controlled.world), false);
    assert.equal(readFileSync(overCapable.world, 'utf8'), TASK_PACKET.content);

    // Worker assertions are inert. Neither arm can promote itself to project truth.
    assert.equal(controlledResult.declared_disposition, 'DONE');
    assert.equal(overCapableResult.declared_disposition, 'DONE');
    assert.equal(controlled.kernel.inspect()[0].status, 'EXECUTING');
    assert.equal(overCapable.kernel.inspect()[0].status, 'EXECUTING');

    // The controlled arm has authoritative absence, so trusted resolution may
    // release the work back to READY. It still must not accept the worker's DONE.
    const controlledResolution = controlled.kernel.resolve(controlled.run);
    assert.equal(controlledResolution.disposition, 'READY');
    assert.equal(controlledResolution.verified, false);

    // The foreign substrate did change external reality, but only trusted
    // verification + settlement may convert that observation into project truth.
    assert.equal(overCapable.kernel.inspect()[0].status, 'EXECUTING');
    const settled = overCapable.kernel.resolve(overCapable.run);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(overCapable.kernel.inspect()[0].status, 'DONE');
  } finally {
    rmSync(controlled.root, { recursive: true, force: true });
    rmSync(overCapable.root, { recursive: true, force: true });
  }
});
