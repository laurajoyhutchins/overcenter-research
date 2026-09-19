import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ObservationOperation, RawObservation } from './observation.ts';
import { sha256 } from './observation.ts';
import { validateObservationSlice, type SchemaResolver } from '../provider-observation/response-slice.ts';
import {
  assembleCompleteList,
  evaluateSnapshotMembership,
  projectConfigMap,
  projectConfigMapListPage,
  projectWatchEvent,
  replaySnapshotAndWatch,
  sameEntityLifetime,
  sameState,
  type ConfigMapFact,
  type ConfigMapListPageFact,
  type WatchEventFact,
  type WatchSegment,
} from './semantics.ts';

const base = 'http://127.0.0.1:8001';
const namespace = 'overcenter-proof';
const name = 'proof';
const observer = { kind: 'github-actions-kind', id: process.env.GITHUB_RUN_ID ?? 'local' };

function kubectl(...args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
}

function op(operation_id: string, schema: unknown): ObservationOperation {
  return { provider: 'kubernetes', api_version: 'v1', method: 'GET', path_template: '', operation_id, outcomes: [{ status: '200', schema }] };
}

async function getText(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  return { status: response.status, text: await response.text() };
}

function raw(operation: ObservationOperation, path: string, query: Record<string, string>, status: number, value?: unknown): RawObservation {
  return {
    contract: {
      provider: 'kubernetes', api_version: 'v1', operation_id: operation.operation_id,
      schema_sha256: schemaDigest,
    },
    observer,
    observed_at: new Date().toISOString(),
    request: { method: 'GET', path, query },
    response: {},
    outcome: {
      status,
      visibility: status === 200 ? 'observed' : status === 404 ? 'not-observed' : 'indeterminate',
      ...(value === undefined ? {} : { value }),
    },
  };
}

const proxy = spawn('kubectl', ['proxy', '--port=8001'], { stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => proxy.kill());
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const ready = await fetch(`${base}/version`);
    if (ready.ok) break;
  } catch {}
  await sleep(100);
  if (attempt === 49) throw new Error('KUBECTL_PROXY_NOT_READY');
}

const discovery = await (await fetch(`${base}/openapi/v3`)).json() as { paths?: Record<string, { serverRelativeURL?: string }> };
const coreUrl = discovery.paths?.['api/v1']?.serverRelativeURL;
assert.ok(coreUrl, 'core/v1 OpenAPI v3 discovery URL');
const schemaResponse = await getText(coreUrl);
assert.equal(schemaResponse.status, 200);
const schemaDigest = sha256(schemaResponse.text);
const document = JSON.parse(schemaResponse.text) as { components?: { schemas?: Record<string, unknown> } };
const schemas = document.components?.schemas ?? {};
const configMapSchema = schemas['io.k8s.api.core.v1.ConfigMap'];
const configMapListSchema = schemas['io.k8s.api.core.v1.ConfigMapList'];
assert.ok(configMapSchema && configMapListSchema, 'ConfigMap OpenAPI schemas');
const resolveRef: SchemaResolver = ref => {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) throw new Error(`KUBERNETES_OPENAPI_EXTERNAL_REF:${ref}`);
  const key = decodeURIComponent(ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~'));
  const found = schemas[key];
  if (!found) throw new Error(`KUBERNETES_OPENAPI_REF_NOT_FOUND:${ref}`);
  return found;
};

const getOp = op('core/v1/configmaps/get', configMapSchema);
const listOp = op('core/v1/configmaps/list', configMapListSchema);
const watchObjectOp = op('core/v1/configmaps/watch-object', configMapSchema);
const objectFields = [
  { path: 'apiVersion' }, { path: 'kind' }, { path: 'metadata.name' }, { path: 'metadata.namespace' },
  { path: 'metadata.uid' }, { path: 'metadata.resourceVersion' }, { path: 'data' },
] as const;
const listFields = [
  { path: 'apiVersion' }, { path: 'kind' }, { path: 'metadata.resourceVersion' }, { path: 'metadata.continue', required: false },
  { path: 'items[].metadata.name' },
  { path: 'items[].metadata.namespace' }, { path: 'items[].metadata.uid' }, { path: 'items[].metadata.resourceVersion' },
  { path: 'items[].data' },
] as const;

kubectl('create', 'namespace', namespace);
kubectl('create', 'configmap', name, '-n', namespace, '--from-literal=value=one');

async function observeGet(): Promise<ConfigMapFact> {
  const path = `/api/v1/namespaces/${namespace}/configmaps/${name}`;
  const response = await getText(path);
  assert.equal(response.status, 200);
  const observation = raw(getOp, path, {}, response.status, JSON.parse(response.text));
  const certified = validateObservationSlice(getOp, observation, objectFields, resolveRef);
  const fact = projectConfigMap(certified);
  assert.ok(fact);
  return fact;
}

const first = await observeGet();
kubectl('patch', 'configmap', name, '-n', namespace, '--type=merge', '-p', '{"data":{"value":"two"}}');
const second = await observeGet();
assert.equal(sameEntityLifetime(first, second), true);
assert.equal(sameState(first, second), false);
assert.notEqual(first.state.resource_version, second.state.resource_version);

kubectl('delete', 'configmap', name, '-n', namespace, '--wait=true');
kubectl('create', 'configmap', name, '-n', namespace, '--from-literal=value=reborn');
const recreated = await observeGet();
assert.deepEqual(first.coordinate, recreated.coordinate);
assert.notEqual(first.entity.uid, recreated.entity.uid);
assert.equal(sameEntityLifetime(first, recreated), false);

kubectl('create', 'configmap', 'distractor', '-n', namespace, '--from-literal=value=x');

async function completeList(): Promise<{ pages: ConfigMapListPageFact[]; snapshot: NonNullable<ReturnType<typeof assembleCompleteList>> }> {
  const pages: ConfigMapListPageFact[] = [];
  let token: string | null = null;
  do {
    const query: Record<string, string> = { limit: '1' };
    if (token !== null) query.continue = token;
    const params = new URLSearchParams(query);
    const path = `/api/v1/namespaces/${namespace}/configmaps?${params}`;
    const response = await getText(path);
    assert.equal(response.status, 200);
    const observation = raw(listOp, path, query, response.status, JSON.parse(response.text));
    const certified = validateObservationSlice(listOp, observation, listFields, resolveRef);
    const page = projectConfigMapListPage(certified, namespace);
    assert.ok(page);
    pages.push(page);
    token = page.response_continue === '' ? null : page.response_continue;
  } while (token !== null);
  const snapshot = assembleCompleteList(pages);
  assert.ok(snapshot);
  return { pages, snapshot };
}

const { pages, snapshot } = await completeList();
assert.ok(pages.length >= 2, 'pagination was exercised');
assert.equal(evaluateSnapshotMembership(snapshot, recreated.coordinate).state, 'PRESENT');
assert.equal(evaluateSnapshotMembership(snapshot, { ...recreated.coordinate, name: 'definitely-missing' }).state, 'ABSENT');

async function watchAndMutate(startResourceVersion: string, initialUid: string): Promise<WatchSegment> {
  const controller = new AbortController();
  const query = { watch: '1', resourceVersion: startResourceVersion, allowWatchBookmarks: 'true', timeoutSeconds: '15' };
  const params = new URLSearchParams(query);
  const path = `/api/v1/namespaces/${namespace}/configmaps?${params}`;
  const response = await fetch(`${base}${path}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const mutation = (async () => {
    await sleep(250);
    kubectl('patch', 'configmap', name, '-n', namespace, '--type=merge', '-p', '{"data":{"value":"watched"}}');
    kubectl('delete', 'configmap', name, '-n', namespace, '--wait=true');
    kubectl('create', 'configmap', name, '-n', namespace, '--from-literal=value=final');
  })();

  const events: WatchEventFact[] = [];
  let buffer = '';
  let sawDelete = false;
  let finalUid: string | null = null;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type?: string; object?: unknown };
        if (event.type === 'ERROR') throw new Error(`KUBERNETES_WATCH_ERROR:${JSON.stringify(event.object)}`);
        if (event.type === 'BOOKMARK') continue;
        if (!event.type || !event.object) continue;
        const observation = raw(watchObjectOp, path, query, 200, event.object);
        const certified = validateObservationSlice(watchObjectOp, observation, objectFields, resolveRef);
        const projected = projectWatchEvent(event.type, certified);
        if (!projected) throw new Error(`KUBERNETES_WATCH_EVENT_UNPROJECTABLE:${event.type}`);
        if (projected.object.coordinate.name !== name) continue;
        events.push(projected);
        if (projected.type === 'DELETED' && projected.object.entity.uid === initialUid) sawDelete = true;
        if (projected.type === 'ADDED' && sawDelete && projected.object.entity.uid !== initialUid) {
          finalUid = projected.object.entity.uid;
          controller.abort();
          break;
        }
      }
      if (finalUid) break;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError') && !(error instanceof Error && error.name === 'AbortError')) throw error;
  }
  await mutation;
  assert.ok(finalUid, 'watch observed replacement lifetime');
  const last = events.at(-1)?.object.state.resource_version ?? startResourceVersion;
  return { namespace, start_resource_version: startResourceVersion, events, continuity: 'maintained', termination: 'client-stop', last_resource_version: last };
}

const proofBeforeWatch = snapshot.members.find(member => member.coordinate.name === name);
assert.ok(proofBeforeWatch);
const segment = await watchAndMutate(snapshot.snapshot_resource_version, proofBeforeWatch.entity.uid);
const reconstructed = replaySnapshotAndWatch(snapshot, segment);
assert.ok(reconstructed);
const fresh = await observeGet();
const rebuilt = reconstructed.get(`${namespace}/${name}`);
assert.ok(rebuilt);
assert.deepEqual({ coordinate: rebuilt.coordinate, uid: rebuilt.entity.uid, rv: rebuilt.state.resource_version, data: rebuilt.data }, { coordinate: fresh.coordinate, uid: fresh.entity.uid, rv: fresh.state.resource_version, data: fresh.data });

// A fresh kind cluster does not reliably compact an old enough RV during this short proof.
// We still probe the provider and record whether the stale-RV branch is observable.
let staleWatch = 'not-reproduced';
try {
  const stale = await fetch(`${base}/api/v1/namespaces/${namespace}/configmaps?watch=1&resourceVersion=1&timeoutSeconds=1`);
  if (stale.status === 410) staleWatch = '410-gone';
  else {
    const text = await stale.text();
    if (text.includes('"code":410') || text.includes('Expired') || text.includes('too old resource version')) staleWatch = '410-gone';
  }
} catch {}

console.log(JSON.stringify({
  result: 'PASS',
  provider: 'kubernetes',
  kubernetes_version: kubectl('version', '-o', 'json'),
  openapi_core_v1_sha256: schemaDigest,
  initial: { uid: first.entity.uid, resourceVersion: first.state.resource_version },
  mutated: { uid: second.entity.uid, resourceVersion: second.state.resource_version },
  recreated: { uid: recreated.entity.uid, resourceVersion: recreated.state.resource_version },
  list: { page_count: pages.length, snapshot_resourceVersion: snapshot.snapshot_resource_version, authoritative_missing: true },
  watch: { event_types: segment.events.map(event => event.type), continuity: segment.continuity, last_resourceVersion: segment.last_resource_version, stale_probe: staleWatch },
  reconstruction: { uid: rebuilt.entity.uid, resourceVersion: rebuilt.state.resource_version, exact_match: true },
}, null, 2));
proxy.kill();
