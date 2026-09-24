import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import type { ExecutionPermit, KubernetesConfigMapExistsPostcondition } from '../../src/model.ts';
import {
  carryKubernetesAbsenceThroughWatch,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../../src/providers/kubernetes/configmap.ts';
import {
  SEMANTIC_EFFECT_INTENT_SCHEMA,
  SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION,
} from '../../src/semantic-effect.ts';

const EFFECT_CONTRACT = 'kubernetes-configmap/ensure';
const AUTHORITY = 'kind:experiment-cluster';
const NAMESPACE = 'overcenter-proof';
const NAME = 'target';
const SCHEMA_SHA = 'a'.repeat(64);

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

type ObjectState = {
  name: string;
  namespace: string;
  uid: string;
  resourceVersion: string;
};

type PatchMode = 'success' | 'timeout-after-commit' | 'timeout-before-commit' | 'conflict';

class FakeKubernetesApi {
  #object: ObjectState | null = null;
  #rv = 100;
  #uid = 0;
  patchCalls = 0;

  list: KubernetesListConfigMaps = (request) => this.#list(request);

  snapshot(): ObjectState | null {
    return this.#object ? structuredClone(this.#object) : null;
  }

  deleteTarget(): void {
    if (this.#object) {
      this.#rv += 1;
      this.#object = null;
    }
  }

  externalCreate(): ObjectState {
    this.#rv += 1;
    this.#uid += 1;
    this.#object = {
      name: NAME,
      namespace: NAMESPACE,
      uid: 'uid-' + this.#uid,
      resourceVersion: String(this.#rv),
    };
    return structuredClone(this.#object);
  }

  async patch(
    request: { authority_id: string; namespace: string; name: string },
    mode: PatchMode,
  ): Promise<ObjectState> {
    this.patchCalls += 1;
    assert.equal(request.authority_id, AUTHORITY);
    assert.equal(request.namespace, NAMESPACE);
    assert.equal(request.name, NAME);

    if (mode === 'timeout-before-commit') {
      throw new Error('KUBERNETES_PATCH_TRANSPORT_UNCERTAIN:BEFORE_COMMIT');
    }
    if (mode === 'conflict') {
      throw new Error('KUBERNETES_PATCH_FAILED:409:RESOURCE_VERSION_CONFLICT');
    }

    if (!this.#object) this.externalCreate();
    else {
      this.#rv += 1;
      this.#object.resourceVersion = String(this.#rv);
    }
    const committed = this.snapshot()!;
    if (mode === 'timeout-after-commit') {
      throw new Error('KUBERNETES_PATCH_TRANSPORT_UNCERTAIN:AFTER_COMMIT');
    }
    return committed;
  }

  #list(request: {
    authority_id: string;
    namespace: string;
    continue_token: string | null;
    limit: number;
  }): KubernetesConfigMapListRead {
    assert.equal(request.authority_id, AUTHORITY);
    assert.equal(request.namespace, NAMESPACE);
    assert.equal(request.continue_token, null);
    const items = this.#object ? [{ metadata: structuredClone(this.#object) }] : [];
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
        observer: { kind: 'experiment', id: 'kubernetes-configmap-effect' },
        observed_at: '2026-09-23T21:30:00.000Z',
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
            metadata: { resourceVersion: String(this.#rv), continue: '' },
            items,
          },
        },
      },
    };
  }
}

function postcondition(): KubernetesConfigMapExistsPostcondition {
  return {
    verifier: 'kubernetes-configmap-exists/v1',
    provider: 'kubernetes',
    authority_id: AUTHORITY,
    api_group: '',
    resource: 'configmaps',
    namespace: NAMESPACE,
    name: NAME,
  };
}

function semanticEnsure(id: string) {
  return {
    id,
    dependencies: [],
    packet: {
      effect_contract: EFFECT_CONTRACT,
      semantic_intent: {
        schema: SEMANTIC_EFFECT_INTENT_SCHEMA,
        schema_version: SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION,
        kind: 'ensure',
        resource: 'kubernetes.configmap',
        target: { authority_id: AUTHORITY, namespace: NAMESPACE, name: NAME },
        desired: { exists: true },
      },
    },
    postcondition: postcondition(),
  };
}

function fixture(api: FakeKubernetesApi) {
  const root = mkdtempSync(join(tmpdir(), 'kubernetes-configmap-effect-'));
  const database = join(root, 'overcenter.sqlite');
  const kernel = new OvercenterKernel(database, {
    observationContext: { kubernetesListConfigMaps: api.list },
  });
  kernel.initialize();
  kernel.define(semanticEnsure('ensure-configmap'));
  return { root, database, kernel };
}

function claim(kernel: OvercenterKernel): ExecutionPermit {
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  return kernel.claim(ready.id, ready.revision);
}

async function performExperimentalConfigMapEffect(
  kernel: OvercenterKernel,
  permit: ExecutionPermit,
  api: FakeKubernetesApi,
  mode: PatchMode,
): Promise<ObjectState> {
  const work = kernel.claimedWork(permit);
  assert.equal(work.packet.effect_contract, EFFECT_CONTRACT);
  assert.equal(work.postcondition.verifier, 'kubernetes-configmap-exists/v1');
  const p = work.postcondition as KubernetesConfigMapExistsPostcondition;

  // Intentionally use the same sealed generic authority path as production
  // without registering Kubernetes in production dispatch.
  const authority = kernel.authorizeEffect(permit);
  return await kernel.performEffect(authority, () =>
    api.patch({ authority_id: p.authority_id, namespace: p.namespace, name: p.name }, mode),
  );
}

const results: Record<string, unknown> = {};

{
  const api = new FakeKubernetesApi();
  const f = fixture(api);
  try {
    const run = claim(f.kernel);
    const mutation = await performExperimentalConfigMapEffect(f.kernel, run, api, 'success');
    assert.equal(f.kernel.hasUnresolvedEffect(run.id), true);
    const settled = f.kernel.resolve(run);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(settled.observed?.observed_uid, mutation.uid);
    results.ordinary = {
      patch_calls: api.patchCalls,
      uid: mutation.uid,
      resource_version: mutation.resourceVersion,
      disposition: settled.disposition,
    };
  } finally {
    f.kernel.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const api = new FakeKubernetesApi();
  const f = fixture(api);
  try {
    const run = claim(f.kernel);
    await assert.rejects(
      performExperimentalConfigMapEffect(f.kernel, run, api, 'timeout-after-commit'),
      /AFTER_COMMIT/,
    );
    const committed = api.snapshot();
    assert.ok(committed);
    assert.equal(f.kernel.hasUnresolvedEffect(run.id), true);
    const interrupted = f.kernel.recoverInterrupted(run, { source: 'experiment' });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
    const recovery = f.kernel.acquireExecution(run.id);
    const settled = f.kernel.reconcile(recovery);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.observed?.observed_uid, committed.uid);
    assert.equal(api.patchCalls, 1);
    results.timeout_after_commit = {
      patch_calls: api.patchCalls,
      committed_uid: committed.uid,
      disposition: settled.disposition,
    };
  } finally {
    f.kernel.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const api = new FakeKubernetesApi();
  const f = fixture(api);
  try {
    const run = claim(f.kernel);
    await assert.rejects(
      performExperimentalConfigMapEffect(f.kernel, run, api, 'timeout-after-commit'),
      /AFTER_COMMIT/,
    );
    const first = api.snapshot();
    assert.ok(first);
    f.kernel.recoverInterrupted(run, { source: 'experiment' });
    api.deleteTarget();
    const recreated = api.externalCreate();
    assert.notEqual(recreated.uid, first.uid);
    const recovery = f.kernel.acquireExecution(run.id);
    const settled = f.kernel.reconcile(recovery);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.observed?.observed_uid, recreated.uid);
    assert.notEqual(settled.observed?.observed_uid, first.uid);
    results.delete_recreate = {
      original_uid: first.uid,
      recreated_uid: recreated.uid,
      observed_uid: settled.observed?.observed_uid,
    };
  } finally {
    f.kernel.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const api = new FakeKubernetesApi();
  const f = fixture(api);
  try {
    const run = claim(f.kernel);
    const concurrent = api.externalCreate();
    await assert.rejects(
      performExperimentalConfigMapEffect(f.kernel, run, api, 'conflict'),
      /RESOURCE_VERSION_CONFLICT/,
    );
    assert.equal(f.kernel.hasUnresolvedEffect(run.id), true);
    f.kernel.recoverInterrupted(run, { source: 'experiment' });
    const recovery = f.kernel.acquireExecution(run.id);
    const settled = f.kernel.reconcile(recovery);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.observed?.observed_uid, concurrent.uid);
    assert.equal(api.patchCalls, 1);
    results.resource_version_race = {
      patch_calls: api.patchCalls,
      concurrent_uid: concurrent.uid,
      disposition: settled.disposition,
    };
  } finally {
    f.kernel.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const api = new FakeKubernetesApi();
  const f = fixture(api);
  try {
    const before = observeCertifiedKubernetesConfigMap(postcondition(), { list: api.list });
    assert.equal(before.state, 'absent');
    assert.ok(before.absence_evidence);

    const run = claim(f.kernel);
    await assert.rejects(
      performExperimentalConfigMapEffect(f.kernel, run, api, 'timeout-before-commit'),
      /BEFORE_COMMIT/,
    );
    f.kernel.recoverInterrupted(run, { source: 'experiment' });

    const stale = carryKubernetesAbsenceThroughWatch(postcondition(), before.absence_evidence, {
      authority_id: AUTHORITY,
      namespace: NAMESPACE,
      start_resource_version: before.snapshot_resource_version!,
      last_resource_version: String(Number(before.snapshot_resource_version!) + 1),
      continuity: 'broken-relist-required',
      termination: 'gone',
      target_events: [],
    });
    assert.equal(stale, null);

    const recovery = f.kernel.acquireExecution(run.id);
    const callsBeforeRetry = api.patchCalls;
    await assert.rejects(
      performExperimentalConfigMapEffect(f.kernel, recovery, api, 'success'),
      /RUN_NOT_EXECUTING|UNRESOLVED_EFFECT/,
    );
    assert.equal(api.patchCalls, callsBeforeRetry);

    const relisted = f.kernel.reconcile(recovery);
    assert.equal(relisted.observed?.mutation_certainty, 'absent');
    assert.equal(relisted.disposition, 'RECOVERY_REQUIRED');
    assert.equal(f.kernel.hasUnresolvedEffect(run.id), true);
    results.stale_watch_and_retry = {
      stale_watch_carried_absence: false,
      retry_patch_calls: api.patchCalls - callsBeforeRetry,
      retry_blocked_before_provider_io: true,
      relist_disposition: relisted.disposition,
      unresolved_effect: true,
    };
  } finally {
    f.kernel.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}

const kernelSource = readFileSync(
  new URL('../../src/authority/engine.ts', import.meta.url),
  'utf8',
);
assert.equal(/kubernetes/i.test(kernelSource), false);
results.kernel_provider_special_cases = 0;

console.log(JSON.stringify(results, null, 2));
