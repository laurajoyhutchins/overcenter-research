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

export interface ObservationRequest {
  method: 'GET' | 'HEAD';
  path_template: string;
  path: string;
  parameters: Record<string, string | number | boolean>;
}

export interface RawObservation {
  contract: {
    provider: 'github';
    api_version: string;
    operation_id: string;
  };
  request: ObservationRequest;
  outcome: {
    status: number;
    visibility: ObservationVisibility;
    value?: unknown;
  };
}

export interface ObservationTransport {
  request(input: {
    method: 'GET' | 'HEAD';
    path: string;
    apiVersion: string;
  }): Promise<{ status: number; body?: unknown }>;
}

const READ_METHODS = new Set(['get', 'head']);

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

function materializeRequest(operation: ObservationOperation, values: Record<string, string | number | boolean>): ObservationRequest {
  let path = operation.path_template;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) {
    const value = values[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw new Error(`OBSERVATION_PARAMETER_REQUIRED:${parameter.name}`);
      continue;
    }
    if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodePathValue(value));
    if (parameter.in === 'query') query.append(parameter.name, String(value));
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('OBSERVATION_PATH_UNRESOLVED');
  const suffix = query.toString();
  return {
    method: operation.method,
    path_template: operation.path_template,
    path: suffix ? `${path}?${suffix}` : path,
    parameters: structuredClone(values),
  };
}

export async function observeOperation(
  operation: ObservationOperation,
  values: Record<string, string | number | boolean>,
  transport: ObservationTransport,
): Promise<RawObservation> {
  const request = materializeRequest(operation, values);
  try {
    const response = await transport.request({
      method: operation.method,
      path: request.path,
      apiVersion: operation.api_version,
    });
    const visibility: ObservationVisibility = response.status >= 200 && response.status < 300
      ? 'observed'
      : response.status === 404
        ? 'not-observed'
        : 'indeterminate';
    return {
      contract: {
        provider: 'github',
        api_version: operation.api_version,
        operation_id: operation.operation_id,
      },
      request,
      outcome: {
        status: response.status,
        visibility,
        ...(response.body === undefined ? {} : { value: response.body }),
      },
    };
  } catch {
    return {
      contract: {
        provider: 'github',
        api_version: operation.api_version,
        operation_id: operation.operation_id,
      },
      request,
      outcome: {
        status: 0,
        visibility: 'indeterminate',
      },
    };
  }
}
