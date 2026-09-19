import { createHash } from 'node:crypto';
import type { ProviderObservation } from '../provider-observation/observation.ts';

export interface ObservationOperation {
  provider: 'kubernetes';
  api_version: string;
  method: 'GET';
  path_template: string;
  operation_id: string;
  outcomes: Array<{ status: string; schema: unknown }>;
}

export interface KubernetesObservationRequest {
  method: 'GET';
  path: string;
  query: Record<string, string>;
}

export type RawObservation = ProviderObservation<
  'kubernetes',
  KubernetesObservationRequest,
  Record<string, never>
>;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
