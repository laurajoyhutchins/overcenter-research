import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { OvercenterKernel, runCoreLoop } from '../src/authority/kernel.ts';
import {
  carryKubernetesAbsenceThroughWatch,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../src/providers/kubernetes/configmap.ts';
import { dispatchAdmittedEffect } from '../src/providers/effect-dispatch.ts';
import { kubernetesConfigMap } from '../src/providers/kubernetes/configmap-resource.ts';

const AUTHORITY = 'kind:production-proof';
const NAMESPACE = 'production';
const NAME = 'api-config';
const SCHEMA_SHA = 'b'.repeat(64);

const operation = {
  operation_id: KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  outcomes: [
    {
      status: '200',
      schema: {
        type: 'object',
        required: ['apiVersion', 'kind', 'metadata', 'items'],
        properties: {
          apiVersion: { type: 'string' },
          kind: { type: 'string' },
          metadata: {
            type: 'object',
            required: ['resourceVersion'],
            properties: {
              resourceVersion: { type: 'string' },
              continue: { type: 'string' },
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['metadata'],
              properties: {
                metadata: {
                  type: 'object',
                  required: ['name', 'namespace', 'uid', 'resourceVersion'],
                  properties: {
                    name: { type: 'string' },
                    namespace: { type: 'string' },
                    uid: { type: 'string' },
                    resourceVersion: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
};

function listConfigMaps(
  present: () => boolean,
  resourceVersion: () => string,
  uid: () => string = () => 'uid-configmap',
): KubernetesListConfigMaps {
  return (request): KubernetesConfigMapListRead => {
    assert.equal(request.authority_id, AUTHORITY);
    assert.equal(request.namespace, NAMESPACE);
    assert.equal(request.continue_token, null);
    const rv = resourceVersion();
    return {
      operation,
      observation: {
        contract: {
          provider: 'kubernetes',
          api_version: 'v1',
          operation_id: KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
          schema_sha256: SCHEMA_SHA,
        },
        authority_id: AUTHORITY,
        observer: { kind: 'test', id: 'kubernetes-configmap-core-loop' },
        observed_at: '2026-09-23T22:00:00.000Z',
        request: {
          namespace: request.namespace,
          continue_token: request.continue_token,
          limit: request.limit,
        },
        response: {},
        outcome: {
          status: 200,
          visibility: 'observed',
          value: {
            apiVersion: 'v1',
            kind: 'ConfigMapList',
            metadata: { resourceVersion: rv, continue: '' },
            items: present()
              ? [
                  {
                    metadata: {
                      name: NAME,
                      namespace: NAMESPACE,
                      uid: uid(),
                      resourceVersion: rv,
                    },
                  },
                ]
              : [],
          },
        },
      },
    };
  };
}

function reservationCount(database: string): number {
  const db = new DatabaseSync(database);
  try {
    const rows = db.prepare('SELECT files_json FROM fact_commits').all() as Array<{
      files_json: string;
    }>;
    return rows.filter((row) =>
      Object.hasOwn(JSON.parse(row.files_json), 'effect-reservation.json'),
    ).length;
  } finally {
    db.close();
  }
}

test('core loop reserves before Kubernetes mutation and settles from LIST evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-core-loop-'));
  const database = join(root, 'overcenter.sqlite');
  let present = false;
  let resourceVersion = '500';
  const list = listConfigMaps(
    () => present,
    () => resourceVersion,
  );
  const kernel = new OvercenterKernel(database, {
    observationContext: { kubernetesListConfigMaps: list },
  });
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-proof',
        target: {
          authority_id: AUTHORITY,
          namespace: NAMESPACE,
          name: NAME,
        },
        desired: { exists: true },
      }),
    );

    const result = await runCoreLoop(kernel, {
      trustedEffects: {
        kubernetes: {
          configMapApply: async (request) => {
            patches += 1;
            const running = kernel.inspect().find((work) => work.id === 'configmap-proof');
            assert.ok(running?.run_id);
            assert.equal(kernel.hasUnresolvedEffect(running.run_id), true);
            assert.equal(request.authority_id, AUTHORITY);
            present = true;
            resourceVersion = '501';
            return { status: 200, body: '{}' };
          },
        },
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(patches, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
    const receipt = kernel.receipts().at(-1);
    assert.equal(receipt?.verified, true);
    assert.equal(receipt?.observed?.observed_uid, 'uid-configmap');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout after Kubernetes mutation cannot replay and settles from observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-timeout-after-commit-'));
  const database = join(root, 'overcenter.sqlite');
  let present = false;
  let resourceVersion = '600';
  const kernel = new OvercenterKernel(database, {
    observationContext: {
      kubernetesListConfigMaps: listConfigMaps(
        () => present,
        () => resourceVersion,
      ),
    },
  });
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-timeout-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );

    const result = await runCoreLoop(kernel, {
      trustedEffects: {
        kubernetes: {
          configMapApply: async () => {
            patches += 1;
            present = true;
            resourceVersion = '601';
            throw new Error('TIMEOUT_AFTER_COMMIT');
          },
        },
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(patches, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
    assert.equal(kernel.receipts().at(-1)?.verified, true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes conflict stays recovery-required and cannot trigger another PATCH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-conflict-'));
  const database = join(root, 'overcenter.sqlite');
  const kernel = new OvercenterKernel(database, {
    observationContext: {
      kubernetesListConfigMaps: listConfigMaps(
        () => false,
        () => '700',
      ),
    },
  });
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-conflict-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );

    const first = await runCoreLoop(kernel, {
      trustedEffects: {
        kubernetes: {
          configMapApply: async () => {
            patches += 1;
            return { status: 409, body: 'Conflict' };
          },
        },
      },
    });

    assert.equal(first.state, 'RECOVERY_REQUIRED');
    assert.equal(patches, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'RECOVERY_REQUIRED');

    const second = await runCoreLoop(kernel, {
      trustedEffects: {
        kubernetes: {
          configMapApply: async () => {
            patches += 1;
            return { status: 200, body: '{}' };
          },
        },
      },
    });

    assert.equal(second.state, 'IDLE');
    assert.equal(patches, 1);
    assert.equal(reservationCount(database), 1);
    assert.equal(kernel.inspect()[0]?.status, 'RECOVERY_REQUIRED');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes EffectAuthority does not expose the raw execution permit', () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-opaque-authority-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-authority-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);
    const authority = kernel.authorizeEffect(permit, kubernetesConfigMap.effect_contract);

    assert.equal(Object.hasOwn(authority, 'permit'), false);
    assert.equal(Object.isFrozen(authority), true);
    assert.equal(Object.isFrozen(authority.postcondition), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate Kubernetes dispatch is fenced before a second provider mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-duplicate-dispatch-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-duplicate-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const permit = kernel.claim(ready.id, ready.revision);
    const context = {
      kubernetes: {
        configMapApply: async () => {
          patches += 1;
          return { status: 200, body: '{}' };
        },
      },
    };

    await dispatchAdmittedEffect(kernel, permit, context);
    await assert.rejects(dispatchAdmittedEffect(kernel, permit, context), /UNRESOLVED_EFFECT/);
    assert.equal(patches, 1);
    assert.equal(reservationCount(kernel.path), 1);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes 409 settles only through authoritative LIST evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-conflict-present-'));
  let present = false;
  let resourceVersion = '750';
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    observationContext: {
      kubernetesListConfigMaps: listConfigMaps(
        () => present,
        () => resourceVersion,
      ),
    },
  });
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-conflict-present-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );

    const result = await runCoreLoop(kernel, {
      trustedEffects: {
        kubernetes: {
          configMapApply: async () => {
            patches += 1;
            present = true;
            resourceVersion = '751';
            return { status: 409, body: 'Conflict' };
          },
        },
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(patches, 1);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
    assert.equal(kernel.receipts().at(-1)?.observed?.observed_resource_version, '751');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous Kubernetes mutation settles replacement identity without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-uid-replacement-'));
  let present = false;
  let resourceVersion = '800';
  let uid = 'uid-original';
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    observationContext: {
      kubernetesListConfigMaps: listConfigMaps(
        () => present,
        () => resourceVersion,
        () => uid,
      ),
    },
  });
  let patches = 0;

  try {
    kernel.initialize();
    kernel.define(
      kubernetesConfigMap.ensure({
        id: 'configmap-uid-replacement-proof',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      }),
    );
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const run = kernel.claim(ready.id, ready.revision);

    await assert.rejects(
      dispatchAdmittedEffect(kernel, run, {
        kubernetes: {
          configMapApply: async () => {
            patches += 1;
            present = true;
            resourceVersion = '801';
            uid = 'uid-original';
            throw new Error('TIMEOUT_AFTER_COMMIT');
          },
        },
      }),
      /TIMEOUT_AFTER_COMMIT/,
    );
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);

    kernel.recoverInterrupted(run, { source: 'red-team' });
    uid = 'uid-replacement';
    resourceVersion = '802';
    const recovery = kernel.acquireExecution(run.id);
    const settled = kernel.reconcile(recovery);

    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.observed?.observed_uid, 'uid-replacement');
    assert.equal(settled.observed?.observed_resource_version, '802');
    assert.equal(patches, 1);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production ConfigMap postcondition rejects stale WATCH continuity', () => {
  const obligation = kubernetesConfigMap.ensure({
    id: 'configmap-watch-proof',
    target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
    desired: { exists: true },
  });
  const postcondition = obligation.postcondition;
  if (postcondition.verifier !== 'kubernetes-configmap-exists/v1') {
    throw new Error('unexpected postcondition verifier');
  }

  const before = observeCertifiedKubernetesConfigMap(postcondition, {
    list: listConfigMaps(
      () => false,
      () => '900',
    ),
  });
  assert.equal(before.state, 'absent');
  assert.ok(before.absence_evidence);

  const stale = carryKubernetesAbsenceThroughWatch(postcondition, before.absence_evidence, {
    authority_id: AUTHORITY,
    namespace: NAMESPACE,
    start_resource_version: before.snapshot_resource_version!,
    last_resource_version: '901',
    continuity: 'broken-relist-required',
    termination: 'gone',
    target_events: [],
  });
  assert.equal(stale, null);
});
