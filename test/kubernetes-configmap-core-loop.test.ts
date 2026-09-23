import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { OvercenterKernel, runCoreLoop } from '../src/authority/kernel.ts';
import {
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../src/providers/kubernetes/configmap.ts';
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
                      uid: 'uid-configmap',
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

test('core loop promotes Kubernetes ConfigMap ensure through sealed authority and authoritative settlement', async () => {
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
