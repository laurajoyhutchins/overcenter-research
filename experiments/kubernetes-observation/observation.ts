import { createHash } from 'node:crypto';

export type ObservationVisibility = 'observed' | 'not-observed' | 'indeterminate';

export interface ObservationOperation {
  provider: string;
  api_version: string;
  method: 'GET';
  path_template: string;
  operation_id: string;
  outcomes: Array<{ status: string; schema: unknown }>;
}

export interface RawObservation {
  contract: {
    provider: string;
    api_version: string;
    operation_id: string;
    schema_sha256: string;
  };
  observer: { kind: string; id: string };
  observed_at: string;
  request: {
    method: 'GET';
    path: string;
    query: Record<string, string>;
  };
  outcome: {
    status: number;
    visibility: ObservationVisibility;
    value?: unknown;
    transport_error?: string;
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return sha256(JSON.stringify(canonical(value)));
}
