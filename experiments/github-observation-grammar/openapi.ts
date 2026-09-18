export type JsonObject = Record<string, unknown>;
export type ObservationVisibility = 'observed' | 'not-observed' | 'indeterminate';

interface OpenApiParameter extends JsonObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: unknown;
}

interface OpenApiResponse extends JsonObject {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}

interface OpenApiOperation extends JsonObject {
  operationId?: string;
  parameters?: OpenApiParameter[];
  responses?: Record<string, OpenApiResponse>;
  'x-github'?: JsonObject;
}

interface OpenApiPathItem extends JsonObject {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  head?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

export interface OpenApiDocument extends JsonObject {
  paths?: Record<string, OpenApiPathItem>;
}

export interface ObservationParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: unknown;
}

export interface ObservationOutcome {
  status: string;
  description: string;
  schema: unknown;
}

export interface ObservationOperation {
  provider: 'github';
  api_version: string;
  method: 'GET' | 'HEAD';
  path_template: string;
  operation_id: string;
  parameters: ObservationParameter[];
  outcomes: ObservationOutcome[];
  github_extensions: JsonObject;
}

export interface ObservationObserver {
  kind: string;
  id: string;
}

export interface ObservationProvenance {
  schema_sha256: string;
  observer: ObservationObserver;
  clock?: () => string;
}

export interface ObservationRequest {
  method: 'GET' | 'HEAD';
  path_template: string;
  path: string;
  parameters: Record<string, string | number | boolean>;
  headers: Record<string, string>;
  authorization: 'bearer' | 'none' | 'unknown';
}

export interface ObservationResponseMetadata {
  date: string | null;
  etag: string | null;
  link: string | null;
  request_id: string | null;
}

export interface ObservationRedirect {
  location: string | null;
}

export interface ObservationTransportRequestEvidence {
  headers: Record<string, string>;
  authorization: 'bearer' | 'none';
}

export interface ObservationTransportResponse {
  status: number;
  body?: unknown;
  redirect?: ObservationRedirect;
  request_evidence?: ObservationTransportRequestEvidence;
  response: ObservationResponseMetadata;
}

export interface RawObservation {
  contract: {
    provider: 'github';
    api_version: string;
    operation_id: string;
    schema_sha256: string;
  };
  observer: ObservationObserver;
  observed_at: string;
  request: ObservationRequest;
  response: ObservationResponseMetadata;
  outcome: {
    status: number;
    visibility: ObservationVisibility;
    value?: unknown;
    redirect?: ObservationRedirect;
    transport_error?: string;
  };
}

export interface ObservationTransport {
  request(input: {
    method: 'GET' | 'HEAD';
    path: string;
    headers: Record<string, string>;
    apiVersion: string;
  }): Promise<ObservationTransportResponse>;
}

const READ_METHODS = new Set(['get', 'head']);
const SHA256 = /^[0-9a-f]{64}$/i;
const RESERVED_REQUEST_HEADERS = new Set(['accept', 'authorization', 'user-agent', 'x-github-api-version']);

function asParameter(value: OpenApiParameter): ObservationParameter {
  if (typeof value.name !== 'string' || !['path', 'query', 'header'].includes(String(value.in))) {
    throw new Error('OPENAPI_PARAMETER_UNSUPPORTED');
  }
  return {
    name: value.name,
    in: value.in as ObservationParameter['in'],
    required: value.in === 'path' ? true : value.required === true,
    schema: value.schema ?? null,
  };
}

function mergeParameters(pathParameters: OpenApiParameter[] = [], operationParameters: OpenApiParameter[] = []): ObservationParameter[] {
  const merged = new Map<string, ObservationParameter>();
  for (const parameter of [...pathParameters, ...operationParameters]) {
    const normalized = asParameter(parameter);
    merged.set(`${normalized.in}:${normalized.name}`, normalized);
  }
  return [...merged.values()].sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`));
}

export function deriveObservationOperation(
  document: OpenApiDocument,
  {
    apiVersion,
    method,
    pathTemplate,
  }: { apiVersion: string; method: string; pathTemplate: string },
): ObservationOperation {
  const normalizedMethod = method.toLowerCase();
  if (!READ_METHODS.has(normalizedMethod)) throw new Error('OBSERVATION_OPERATION_MUST_BE_READ_ONLY');
  const pathItem = document.paths?.[pathTemplate];
  if (!pathItem) throw new Error('OPENAPI_PATH_NOT_FOUND');
  const operation = pathItem[normalizedMethod as 'get' | 'head'];
  if (!operation || typeof operation.operationId !== 'string') throw new Error('OPENAPI_OPERATION_NOT_FOUND');

  const outcomes = Object.entries(operation.responses ?? {}).map(([status, response]) => ({
    status,
    description: typeof response.description === 'string' ? response.description : '',
    schema: response.content?.['application/json']?.schema ?? null,
  })).sort((a, b) => a.status.localeCompare(b.status, undefined, { numeric: true }));

  return {
    provider: 'github',
    api_version: apiVersion,
    method: normalizedMethod.toUpperCase() as 'GET' | 'HEAD',
    path_template: pathTemplate,
    operation_id: operation.operationId,
    parameters: mergeParameters(pathItem.parameters, operation.parameters),
    outcomes,
    github_extensions: operation['x-github'] ?? {},
  };
}

export function deriveObservationCatalog(document: OpenApiDocument, apiVersion: string): ObservationOperation[] {
  const operations: ObservationOperation[] = [];
  for (const pathTemplate of Object.keys(document.paths ?? {}).sort()) {
    const pathItem = document.paths?.[pathTemplate];
    if (!pathItem) continue;
    for (const method of ['get', 'head']) {
      if (!pathItem[method as 'get' | 'head']) continue;
      operations.push(deriveObservationOperation(document, { apiVersion, method, pathTemplate }));
    }
  }
  return operations;
}

function encodePathValue(value: string | number | boolean): string {
  return encodeURIComponent(String(value));
}

function mergeAuxiliaryHeaders(
  generated: Record<string, string>,
  auxiliary: Record<string, string>,
): Record<string, string> {
  const merged = { ...generated };
  for (const [name, value] of Object.entries(auxiliary)) {
    if (RESERVED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new Error(`GITHUB_OBSERVATION_HEADER_RESERVED:${name}`);
    }
    const collision = Object.keys(merged).find(existing => existing.toLowerCase() === name.toLowerCase());
    if (collision) throw new Error(`OBSERVATION_HEADER_DUPLICATE:${name}`);
    merged[name] = value;
  }
  return merged;
}

function materializeRequest(
  operation: ObservationOperation,
  values: Record<string, string | number | boolean>,
  auxiliaryHeaders: Record<string, string> = {},
): ObservationRequest {
  let path = operation.path_template;
  const query = new URLSearchParams();
  const operationHeaders: Record<string, string> = {};
  const parameters: Record<string, string | number | boolean> = {};
  const declared = new Set(operation.parameters.map(parameter => parameter.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new Error(`OBSERVATION_PARAMETER_UNKNOWN:${name}`);
  }
  for (const parameter of operation.parameters) {
    const value = values[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw new Error(`OBSERVATION_PARAMETER_REQUIRED:${parameter.name}`);
      continue;
    }
    parameters[parameter.name] = value;
    if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodePathValue(value));
    if (parameter.in === 'query') query.append(parameter.name, String(value));
    if (parameter.in === 'header') operationHeaders[parameter.name] = String(value);
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('OBSERVATION_PATH_UNRESOLVED');
  const suffix = query.toString();
  return {
    method: operation.method,
    path_template: operation.path_template,
    path: suffix ? `${path}?${suffix}` : path,
    parameters,
    headers: mergeAuxiliaryHeaders(operationHeaders, auxiliaryHeaders),
    authorization: 'unknown',
  };
}

function assertProvenance(provenance: ObservationProvenance): void {
  if (!SHA256.test(provenance.schema_sha256)) throw new Error('OBSERVATION_SCHEMA_DIGEST_REQUIRED');
  if (!provenance.observer || typeof provenance.observer.kind !== 'string' || provenance.observer.kind.length === 0) {
    throw new Error('OBSERVATION_OBSERVER_KIND_REQUIRED');
  }
  if (typeof provenance.observer.id !== 'string' || provenance.observer.id.length === 0) {
    throw new Error('OBSERVATION_OBSERVER_ID_REQUIRED');
  }
}

const emptyResponseMetadata = (): ObservationResponseMetadata => ({
  date: null,
  etag: null,
  link: null,
  request_id: null,
});

export async function observeOperation(
  operation: ObservationOperation,
  values: Record<string, string | number | boolean>,
  transport: ObservationTransport,
  provenance: ObservationProvenance,
  { headers = {} }: { headers?: Record<string, string> } = {},
): Promise<RawObservation> {
  assertProvenance(provenance);
  const request = materializeRequest(operation, values, headers);
  const clock = provenance.clock ?? (() => new Date().toISOString());
  try {
    const response = await transport.request({
      method: operation.method,
      path: request.path,
      headers: request.headers,
      apiVersion: operation.api_version,
    });
    const visibility: ObservationVisibility = response.status >= 200 && response.status < 300
      ? 'observed'
      : response.status === 404
        ? 'not-observed'
        : 'indeterminate';
    const sent = response.request_evidence;
    return {
      contract: {
        provider: 'github',
        api_version: operation.api_version,
        operation_id: operation.operation_id,
        schema_sha256: provenance.schema_sha256.toLowerCase(),
      },
      observer: structuredClone(provenance.observer),
      observed_at: clock(),
      request: {
        ...request,
        headers: sent ? structuredClone(sent.headers) : request.headers,
        authorization: sent?.authorization ?? 'unknown',
      },
      response: response.response,
      outcome: {
        status: response.status,
        visibility,
        ...(response.body === undefined ? {} : { value: response.body }),
        ...(response.redirect === undefined ? {} : { redirect: response.redirect }),
      },
    };
  } catch (error: unknown) {
    return {
      contract: {
        provider: 'github',
        api_version: operation.api_version,
        operation_id: operation.operation_id,
        schema_sha256: provenance.schema_sha256.toLowerCase(),
      },
      observer: structuredClone(provenance.observer),
      observed_at: clock(),
      request,
      response: emptyResponseMetadata(),
      outcome: {
        status: 0,
        visibility: 'indeterminate',
        transport_error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export interface FetchHeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  status: number;
  headers: FetchHeadersLike;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: 'GET' | 'HEAD'; headers: Record<string, string>; redirect: 'manual' },
) => Promise<FetchResponseLike>;

export class GitHubRestTransport implements ObservationTransport {
  readonly token: string | null;
  readonly baseUrl: string;
  readonly fetchFn: FetchLike;

  constructor({
    token = null,
    baseUrl = 'https://api.github.com',
    fetchFn = globalThis.fetch as unknown as FetchLike,
  }: { token?: string | null; baseUrl?: string; fetchFn?: FetchLike } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn;
  }

  async request({
    method,
    path,
    headers: operationHeaders,
    apiVersion,
  }: {
    method: 'GET' | 'HEAD';
    path: string;
    headers: Record<string, string>;
    apiVersion: string;
  }): Promise<ObservationTransportResponse> {
    if (!path.startsWith('/')) throw new Error('GITHUB_OBSERVATION_PATH_MUST_BE_ABSOLUTE');
    for (const name of Object.keys(operationHeaders)) {
      if (RESERVED_REQUEST_HEADERS.has(name.toLowerCase())) throw new Error(`GITHUB_OBSERVATION_HEADER_RESERVED:${name}`);
    }
    const visibleHeaders: Record<string, string> = {
      ...operationHeaders,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': apiVersion,
      'User-Agent': 'overcenter-research-observer',
    };
    const wireHeaders = { ...visibleHeaders };
    if (this.token) wireHeaders.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: wireHeaders,
      redirect: 'manual',
    });
    const metadata: ObservationResponseMetadata = {
      date: response.headers.get('date'),
      etag: response.headers.get('etag'),
      link: response.headers.get('link'),
      request_id: response.headers.get('x-github-request-id'),
    };
    const redirect = response.status >= 300 && response.status < 400 && response.status !== 304
      ? { location: response.headers.get('location') }
      : undefined;
    const text = method === 'HEAD' ? '' : await response.text();
    const common = {
      status: response.status,
      request_evidence: {
        headers: visibleHeaders,
        authorization: this.token ? 'bearer' as const : 'none' as const,
      },
      response: metadata,
      ...(redirect === undefined ? {} : { redirect }),
    };
    if (!text) return common;
    try {
      return { ...common, body: JSON.parse(text) };
    } catch {
      return { ...common, body: text };
    }
  }
}
