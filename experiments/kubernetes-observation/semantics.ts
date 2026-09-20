import type { RawObservation } from './observation.ts';
import { KUBERNETES_CONFIGMAP_LIST_RESPONSE_SLICE } from '../../src/providers/kubernetes-configmap.ts';
import {
  structurallyCertifiedFor,
  type CertifiedObservation,
  type ResponseFieldSpec,
} from '../provider-observation/response-slice.ts';

type StructurallyValidatedObservation = CertifiedObservation<RawObservation>;

export interface KubernetesCoordinate {
  api_group: '';
  resource: 'configmaps';
  namespace: string;
  name: string;
}

export interface KubernetesEntityIdentity {
  uid: string;
}

export interface KubernetesStateIdentity {
  resource_version: string;
}

export interface ConfigMapFact {
  kind: 'kubernetes.configmap-snapshot';
  coordinate: KubernetesCoordinate;
  entity: KubernetesEntityIdentity;
  state: KubernetesStateIdentity;
  api_version: 'v1';
  object_kind: 'ConfigMap';
  data: Record<string, string>;
  observed_at: string;
  evidence: StructurallyValidatedObservation;
}

export interface ConfigMapListPageFact {
  kind: 'kubernetes.configmap-list-page';
  namespace: string;
  snapshot_resource_version: string;
  request_continue: string | null;
  response_continue: string;
  members: ConfigMapFact[];
  observed_at: string;
  evidence: StructurallyValidatedObservation;
}

export interface CompleteConfigMapSnapshot {
  kind: 'kubernetes.configmap-list-snapshot';
  namespace: string;
  snapshot_resource_version: string;
  complete: true;
  members: ConfigMapFact[];
  page_count: number;
}

export interface WatchEventFact {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  object: ConfigMapFact;
}

export interface WatchSegment {
  namespace: string;
  start_resource_version: string;
  events: WatchEventFact[];
  continuity: 'maintained' | 'broken-relist-required';
  termination: 'client-stop' | 'eof' | 'timeout' | 'gone' | 'error';
  last_resource_version: string;
}

export const CONFIGMAP_RESPONSE_SLICE=[
  'apiVersion','kind','metadata.name','metadata.namespace',
  'metadata.uid','metadata.resourceVersion','data',
].map(path=>({path})) satisfies readonly ResponseFieldSpec[];

export const CONFIGMAP_LIST_RESPONSE_SLICE=[
  ...KUBERNETES_CONFIGMAP_LIST_RESPONSE_SLICE,
  {path:'items[].data'},
] satisfies readonly ResponseFieldSpec[];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const body = record(value);
  if (!body || !Object.values(body).every(item => typeof item === 'string')) return null;
  return body as Record<string, string>;
}

function objectFact(value: unknown, observedAt: string, evidence: StructurallyValidatedObservation): ConfigMapFact | null {
  const body = record(value);
  const metadata = record(body?.metadata);
  const data = stringRecord(body?.data);
  if (body?.apiVersion !== 'v1' || body?.kind !== 'ConfigMap' || !metadata || !data) return null;
  if (
    typeof metadata.name !== 'string' || typeof metadata.namespace !== 'string' ||
    typeof metadata.uid !== 'string' || typeof metadata.resourceVersion !== 'string'
  ) return null;
  return {
    kind: 'kubernetes.configmap-snapshot',
    coordinate: { api_group: '', resource: 'configmaps', namespace: metadata.namespace, name: metadata.name },
    entity: { uid: metadata.uid },
    state: { resource_version: metadata.resourceVersion },
    api_version: 'v1',
    object_kind: 'ConfigMap',
    data,
    observed_at: observedAt,
    evidence,
  };
}

function listItemFact(value: unknown, observedAt: string, evidence: StructurallyValidatedObservation): ConfigMapFact | null {
  const body = record(value);
  const metadata = record(body?.metadata);
  const data = stringRecord(body?.data);
  if (!metadata || !data) return null;
  if (
    typeof metadata.name !== 'string' || typeof metadata.namespace !== 'string' ||
    typeof metadata.uid !== 'string' || typeof metadata.resourceVersion !== 'string'
  ) return null;
  return {
    kind: 'kubernetes.configmap-snapshot',
    coordinate: { api_group: '', resource: 'configmaps', namespace: metadata.namespace, name: metadata.name },
    entity: { uid: metadata.uid },
    state: { resource_version: metadata.resourceVersion },
    api_version: 'v1',
    object_kind: 'ConfigMap',
    data,
    observed_at: observedAt,
    evidence,
  };
}

function projectConfigMapFor(observation: RawObservation, operationId: string): ConfigMapFact | null {
  if (!structurallyCertifiedFor(observation,operationId,CONFIGMAP_RESPONSE_SLICE)) return null;
  return objectFact(observation.outcome.value, observation.observed_at, observation);
}

export function projectConfigMap(observation: RawObservation): ConfigMapFact | null {
  return projectConfigMapFor(observation, 'core/v1/configmaps/get');
}

export function projectConfigMapListPage(observation: RawObservation, namespace: string): ConfigMapListPageFact | null {
  if (!structurallyCertifiedFor(
    observation,
    'core/v1/configmaps/list',
    CONFIGMAP_LIST_RESPONSE_SLICE,
  )) return null;
  const body = record(observation.outcome.value);
  const metadata = record(body?.metadata);
  if (body?.apiVersion !== 'v1' || body?.kind !== 'ConfigMapList' || !metadata || !Array.isArray(body.items)) return null;
  if (typeof metadata.resourceVersion !== 'string') return null;
  if (metadata.continue !== undefined && typeof metadata.continue !== 'string') return null;
  const members: ConfigMapFact[] = [];
  for (const item of body.items) {
    const fact = listItemFact(item, observation.observed_at, observation);
    if (!fact || fact.coordinate.namespace !== namespace) return null;
    members.push(fact);
  }
  return {
    kind: 'kubernetes.configmap-list-page',
    namespace,
    snapshot_resource_version: metadata.resourceVersion,
    request_continue: observation.request.query.continue ?? null,
    response_continue: metadata.continue ?? '',
    members,
    observed_at: observation.observed_at,
    evidence: observation,
  };
}

export function sameCoordinate(left: KubernetesCoordinate, right: KubernetesCoordinate): boolean {
  return left.api_group === right.api_group && left.resource === right.resource
    && left.namespace === right.namespace && left.name === right.name;
}

export function sameEntityLifetime(left: ConfigMapFact, right: ConfigMapFact): boolean {
  return sameCoordinate(left.coordinate, right.coordinate) && left.entity.uid === right.entity.uid;
}

export function sameState(left: ConfigMapFact, right: ConfigMapFact): boolean {
  return sameEntityLifetime(left, right) && left.state.resource_version === right.state.resource_version;
}

export function assembleCompleteList(pages: readonly ConfigMapListPageFact[]): CompleteConfigMapSnapshot | null {
  if (pages.length === 0) return null;
  const first = pages[0];
  if (first.request_continue !== null) return null;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page.namespace !== first.namespace || page.snapshot_resource_version !== first.snapshot_resource_version) return null;
    if (index > 0 && page.request_continue !== pages[index - 1].response_continue) return null;
    if (index < pages.length - 1 && page.response_continue === '') return null;
  }
  if (pages.at(-1)?.response_continue !== '') return null;
  return {
    kind: 'kubernetes.configmap-list-snapshot',
    namespace: first.namespace,
    snapshot_resource_version: first.snapshot_resource_version,
    complete: true,
    members: pages.flatMap(page => page.members),
    page_count: pages.length,
  };
}

export function evaluateSnapshotMembership(
  snapshot: CompleteConfigMapSnapshot,
  coordinate: KubernetesCoordinate,
): { state: 'PRESENT' | 'ABSENT' | 'INDETERMINATE'; fact?: ConfigMapFact; at_resource_version?: string } {
  if (coordinate.namespace !== snapshot.namespace || coordinate.api_group !== '' || coordinate.resource !== 'configmaps') {
    return { state: 'INDETERMINATE' };
  }
  const fact = snapshot.members.find(candidate => sameCoordinate(candidate.coordinate, coordinate));
  return fact
    ? { state: 'PRESENT', fact, at_resource_version: snapshot.snapshot_resource_version }
    : { state: 'ABSENT', at_resource_version: snapshot.snapshot_resource_version };
}

export function projectWatchEvent(
  type: string,
  objectObservation: RawObservation,
): WatchEventFact | null {
  if (!['ADDED', 'MODIFIED', 'DELETED'].includes(type)) return null;
  const object = projectConfigMapFor(objectObservation, 'core/v1/configmaps/watch-object');
  if (!object) return null;
  return { type: type as WatchEventFact['type'], object };
}

export function replaySnapshotAndWatch(
  snapshot: CompleteConfigMapSnapshot,
  segment: WatchSegment,
): Map<string, ConfigMapFact> | null {
  if (segment.continuity !== 'maintained' || segment.start_resource_version !== snapshot.snapshot_resource_version) return null;
  const state = new Map(snapshot.members.map(member => [`${member.coordinate.namespace}/${member.coordinate.name}`, member]));
  for (const event of segment.events) {
    const key = `${event.object.coordinate.namespace}/${event.object.coordinate.name}`;
    const current = state.get(key);
    if (event.type === 'DELETED') {
      if (current && current.entity.uid !== event.object.entity.uid) return null;
      state.delete(key);
      continue;
    }
    state.set(key, event.object);
  }
  return state;
}
