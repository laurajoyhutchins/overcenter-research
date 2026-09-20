import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservationOperation, RawObservation } from './observation.ts';
import { validateObservationSlice } from '../provider-observation/response-slice.ts';
import {
  assembleCompleteList,
  CONFIGMAP_LIST_RESPONSE_SLICE,
  CONFIGMAP_RESPONSE_SLICE,
  evaluateSnapshotMembership,
  projectConfigMap,
  projectConfigMapListPage,
  replaySnapshotAndWatch,
  sameEntityLifetime,
  sameState,
  type KubernetesCoordinate,
  type WatchSegment,
} from './semantics.ts';

const configMapSchema = {
  type: 'object', required: ['apiVersion', 'kind', 'metadata'],
  properties: {
    apiVersion: { type: 'string' }, kind: { type: 'string' },
    metadata: { type: 'object', required: ['name', 'namespace', 'uid', 'resourceVersion'], properties: {
      name: { type: 'string' }, namespace: { type: 'string' }, uid: { type: 'string' }, resourceVersion: { type: 'string' },
    } },
    data: { type: 'object' },
  },
};
const listSchema = {
  type: 'object', required: ['apiVersion', 'kind', 'metadata', 'items'], properties: {
    apiVersion: { type: 'string' }, kind: { type: 'string' },
    metadata: { type: 'object', required: ['resourceVersion', 'continue'], properties: {
      resourceVersion: { type: 'string' }, continue: { type: 'string' },
    } },
    items: { type: 'array', items: configMapSchema },
  },
};
const getOp: ObservationOperation = { provider: 'kubernetes', api_version: 'v1', method: 'GET', path_template: '', operation_id: 'core/v1/configmaps/get', outcomes: [{ status: '200', schema: configMapSchema }] };
const listOp: ObservationOperation = { provider: 'kubernetes', api_version: 'v1', method: 'GET', path_template: '', operation_id: 'core/v1/configmaps/list', outcomes: [{ status: '200', schema: listSchema }] };

function raw(operation: ObservationOperation, value: unknown, query: Record<string, string> = {}): RawObservation {
  return { contract: { provider: 'kubernetes', api_version: 'v1', operation_id: operation.operation_id, schema_sha256: 'a'.repeat(64) }, observer: { kind: 'test', id: 'unit' }, observed_at: '2026-09-18T19:00:00Z', request: { method: 'GET', path: '/api/v1/namespaces/default/configmaps', query }, response: {}, outcome: { status: 200, visibility: 'observed', value } };
}
function cm(uid: string, rv: string, data = { value: rv }) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'proof', namespace: 'default', uid, resourceVersion: rv }, data };
}
function certifyGet(value: unknown) {
  return validateObservationSlice(getOp,raw(getOp,value),CONFIGMAP_RESPONSE_SLICE);
}
function listItem(uid: string, rv: string, data = { value: rv }) {
  return { metadata: { name: 'proof', namespace: 'default', uid, resourceVersion: rv }, data };
}
function certifyList(value: unknown, query: Record<string, string> = {}) {
  return validateObservationSlice(listOp,raw(listOp,value,query),CONFIGMAP_LIST_RESPONSE_SLICE);
}

const coordinate: KubernetesCoordinate = { api_group: '', resource: 'configmaps', namespace: 'default', name: 'proof' };

test('GET projects coordinate, UID lifetime, resourceVersion state, and structural certificate', () => {
  const first = projectConfigMap(certifyGet(cm('uid-a', '101')))!;
  const second = projectConfigMap(certifyGet(cm('uid-a', '102')))!;
  assert.deepEqual(first.coordinate, coordinate);
  assert.equal(first.entity.uid, 'uid-a');
  assert.equal(first.state.resource_version, '101');
  assert.equal(sameEntityLifetime(first, second), true);
  assert.equal(sameState(first, second), false);
});

test('delete and recreate at the same coordinate is a new entity lifetime', () => {
  const before = projectConfigMap(certifyGet(cm('uid-a', '101')))!;
  const after = projectConfigMap(certifyGet(cm('uid-b', '900')))!;
  assert.deepEqual(before.coordinate, after.coordinate);
  assert.notEqual(before.entity.uid, after.entity.uid);
  assert.equal(sameEntityLifetime(before, after), false);
});

test('resourceVersion is treated as opaque identity, never ordered', () => {
  const before = projectConfigMap(certifyGet(cm('uid-a', 'z9')))!;
  const after = projectConfigMap(certifyGet(cm('uid-a', 'a1')))!;
  assert.equal(sameState(before, after), false);
});

test('LIST member type comes from the collection contract when per-item TypeMeta is omitted', () => {
  const page = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '498' }, items: [listItem('uid-a', '497')] }), 'default')!;
  assert.equal(page.members[0].api_version, 'v1');
  assert.equal(page.members[0].object_kind, 'ConfigMap');
  assert.equal(page.members[0].entity.uid, 'uid-a');
});

test('a terminal list may omit optional continue and still certify completion', () => {
  const page = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '499' }, items: [listItem('uid-a', '498')] }), 'default')!;
  const snapshot = assembleCompleteList([page]);
  assert.ok(snapshot);
  assert.equal(snapshot.snapshot_resource_version, '499');
  assert.equal(snapshot.members[0].api_version, 'v1');
  assert.equal(snapshot.members[0].object_kind, 'ConfigMap');
});

test('one chunk cannot mint authoritative absence', () => {
  const page = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '500', continue: 'next' }, items: [] }), 'default')!;
  assert.equal(assembleCompleteList([page]), null);
});

test('continued pages only become complete when the chain closes on one snapshot resourceVersion', () => {
  const first = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '500', continue: 'token-1' }, items: [] }), 'default')!;
  const last = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '500', continue: '' }, items: [listItem('uid-a', '499')] }, { continue: 'token-1' }), 'default')!;
  const snapshot = assembleCompleteList([first, last])!;
  assert.equal(snapshot.complete, true);
  assert.equal(evaluateSnapshotMembership(snapshot, coordinate).state, 'PRESENT');
  assert.equal(evaluateSnapshotMembership(snapshot, { ...coordinate, name: 'missing' }).state, 'ABSENT');

  const wrongRv = { ...last, snapshot_resource_version: '501' };
  assert.equal(assembleCompleteList([first, wrongRv]), null);
  const wrongToken = { ...last, request_continue: 'other' };
  assert.equal(assembleCompleteList([first, wrongToken]), null);
});

test('snapshot plus continuous watch reconstructs delete/recreate without collapsing UID lifetimes', () => {
  const initialPage = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '500', continue: '' }, items: [listItem('uid-a', '499', { value: 'old' })] }), 'default')!;
  const snapshot = assembleCompleteList([initialPage])!;
  const deleted = projectConfigMap(certifyGet(cm('uid-a', '501', { value: 'old' })))!;
  const recreated = projectConfigMap(certifyGet(cm('uid-b', '502', { value: 'new' })))!;
  const segment: WatchSegment = { namespace: 'default', start_resource_version: '500', events: [{ type: 'DELETED', object: deleted }, { type: 'ADDED', object: recreated }], continuity: 'maintained', termination: 'timeout', last_resource_version: '502' };
  const rebuilt = replaySnapshotAndWatch(snapshot, segment)!;
  assert.equal(rebuilt.get('default/proof')?.entity.uid, 'uid-b');
  assert.equal(rebuilt.get('default/proof')?.data.value, 'new');
});

test('broken watch continuity fails closed and requires a relist', () => {
  const initialPage = projectConfigMapListPage(certifyList({ apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '500', continue: '' }, items: [listItem('uid-a', '499')] }), 'default')!;
  const snapshot = assembleCompleteList([initialPage])!;
  const broken: WatchSegment = { namespace: 'default', start_resource_version: '500', events: [], continuity: 'broken-relist-required', termination: 'gone', last_resource_version: '500' };
  assert.equal(replaySnapshotAndWatch(snapshot, broken), null);
});
