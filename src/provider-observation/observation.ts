// Provider-neutral evidence envelope only. Provider-specific identity, freshness,
// completeness, and negative-evidence semantics belong outside this module.
export type ObservationVisibility = 'observed' | 'not-observed' | 'indeterminate';

export interface ObservationObserver {
  kind: string;
  id: string;
}

export interface ProviderStructuralValidation {
  operation_id:string;
  status:string;
  validated_paths:string[];
  optional_absent_paths:string[];
  schema_sha256:string;
}

export interface ProviderRevalidationProvenance {
  observed_at:string;
  etag:string;
}

export interface ProviderObservation<
  Provider extends string,
  Request,
  Response,
  OutcomeExtra extends object = object,
> {
  contract: {
    provider: Provider;
    api_version: string;
    operation_id: string;
    schema_sha256: string;
  };
  observer: ObservationObserver;
  observed_at: string;
  request: Request;
  response: Response;
  outcome: {
    status: number;
    visibility: ObservationVisibility;
    value?: unknown;
    transport_error?: string;
  } & OutcomeExtra;
  structural_validation?:ProviderStructuralValidation;
  revalidated_from?:ProviderRevalidationProvenance;
}

export type ProviderObservationExtensionKind = 'non-empty-string';

export interface ProviderObservationValidationOptions {
  topLevelExtensions?: readonly string[];
  requiredTopLevelExtensions?: Readonly<Record<string,ProviderObservationExtensionKind>>;
  outcomeExtensions?: readonly string[];
}

function data(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function exactKeys(
  value:Record<string,unknown>,
  required:readonly string[],
  optional:readonly string[]=[],
  error='PROVIDER_OBSERVATION_SHAPE_INVALID',
):void {
  const allowed=new Set([...required,...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${error}:UNKNOWN_FIELD:${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${error}:MISSING_FIELD:${key}`);
  }
}

function nonEmptyString(value:unknown,error:string):asserts value is string {
  if (typeof value!=='string' || value.length===0 || value.includes('\0')) {
    throw new Error(error);
  }
}

export function validateProviderObservationEnvelope(
  value:unknown,
  {
    topLevelExtensions=[],
    requiredTopLevelExtensions={},
    outcomeExtensions=[],
  }:ProviderObservationValidationOptions={},
):asserts value is ProviderObservation<string,unknown,unknown> {
  if (!data(value)) throw new Error('PROVIDER_OBSERVATION_INVALID');
  const requiredExtensionNames=Object.keys(requiredTopLevelExtensions);
  exactKeys(
    value,
    [
      'contract',
      'observer',
      'observed_at',
      'request',
      'response',
      'outcome',
      ...requiredExtensionNames,
    ],
    ['structural_validation','revalidated_from',...topLevelExtensions],
  );
  for (const [name,kind] of Object.entries(requiredTopLevelExtensions)) {
    if (kind==='non-empty-string') {
      nonEmptyString(
        value[name],
        `PROVIDER_OBSERVATION_EXTENSION_INVALID:${name}`,
      );
    }
  }

  if (!data(value.contract)) throw new Error('PROVIDER_OBSERVATION_CONTRACT_INVALID');
  exactKeys(
    value.contract,
    ['provider','api_version','operation_id','schema_sha256'],
    [],
    'PROVIDER_OBSERVATION_CONTRACT_SHAPE_INVALID',
  );
  nonEmptyString(value.contract.provider,'PROVIDER_OBSERVATION_PROVIDER_INVALID');
  nonEmptyString(value.contract.api_version,'PROVIDER_OBSERVATION_API_VERSION_INVALID');
  nonEmptyString(value.contract.operation_id,'PROVIDER_OBSERVATION_OPERATION_ID_INVALID');
  if (
    typeof value.contract.schema_sha256!=='string'
    || !/^[0-9a-f]{64}$/.test(value.contract.schema_sha256)
  ) throw new Error('PROVIDER_OBSERVATION_SCHEMA_DIGEST_INVALID');

  if (!data(value.observer)) throw new Error('PROVIDER_OBSERVATION_OBSERVER_INVALID');
  exactKeys(
    value.observer,
    ['kind','id'],
    [],
    'PROVIDER_OBSERVATION_OBSERVER_SHAPE_INVALID',
  );
  nonEmptyString(value.observer.kind,'PROVIDER_OBSERVATION_OBSERVER_KIND_INVALID');
  nonEmptyString(value.observer.id,'PROVIDER_OBSERVATION_OBSERVER_ID_INVALID');
  nonEmptyString(value.observed_at,'PROVIDER_OBSERVATION_TIME_INVALID');

  if (!data(value.request)) throw new Error('PROVIDER_OBSERVATION_REQUEST_INVALID');
  if (!data(value.response)) throw new Error('PROVIDER_OBSERVATION_RESPONSE_INVALID');
  if (!data(value.outcome)) throw new Error('PROVIDER_OBSERVATION_OUTCOME_INVALID');
  exactKeys(
    value.outcome,
    ['status','visibility'],
    ['value','transport_error',...outcomeExtensions],
    'PROVIDER_OBSERVATION_OUTCOME_SHAPE_INVALID',
  );
  if (!Number.isSafeInteger(value.outcome.status) || value.outcome.status<0) {
    throw new Error('PROVIDER_OBSERVATION_STATUS_INVALID');
  }
  if (!['observed','not-observed','indeterminate'].includes(String(value.outcome.visibility))) {
    throw new Error('PROVIDER_OBSERVATION_VISIBILITY_INVALID');
  }
  if (
    value.outcome.transport_error!==undefined
    && (
      typeof value.outcome.transport_error!=='string'
      || value.outcome.transport_error.length===0
    )
  ) throw new Error('PROVIDER_OBSERVATION_TRANSPORT_ERROR_INVALID');

  if (value.structural_validation!==undefined) {
    if (!data(value.structural_validation)) {
      throw new Error('PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_INVALID');
    }
    exactKeys(
      value.structural_validation,
      [
        'operation_id',
        'status',
        'validated_paths',
        'optional_absent_paths',
        'schema_sha256',
      ],
      [],
      'PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_SHAPE_INVALID',
    );
    nonEmptyString(
      value.structural_validation.operation_id,
      'PROVIDER_OBSERVATION_STRUCTURAL_OPERATION_INVALID',
    );
    nonEmptyString(
      value.structural_validation.status,
      'PROVIDER_OBSERVATION_STRUCTURAL_STATUS_INVALID',
    );
    if (
      !Array.isArray(value.structural_validation.validated_paths)
      || !value.structural_validation.validated_paths.every(path=>typeof path==='string')
      || !Array.isArray(value.structural_validation.optional_absent_paths)
      || !value.structural_validation.optional_absent_paths.every(path=>typeof path==='string')
      || typeof value.structural_validation.schema_sha256!=='string'
      || !/^[0-9a-f]{64}$/.test(value.structural_validation.schema_sha256)
    ) {
      throw new Error('PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_INVALID');
    }
  }

  if (value.revalidated_from!==undefined) {
    if (!data(value.revalidated_from)) {
      throw new Error('PROVIDER_OBSERVATION_REVALIDATION_INVALID');
    }
    exactKeys(
      value.revalidated_from,
      ['observed_at','etag'],
      [],
      'PROVIDER_OBSERVATION_REVALIDATION_SHAPE_INVALID',
    );
    nonEmptyString(
      value.revalidated_from.observed_at,
      'PROVIDER_OBSERVATION_REVALIDATION_TIME_INVALID',
    );
    nonEmptyString(
      value.revalidated_from.etag,
      'PROVIDER_OBSERVATION_REVALIDATION_ETAG_INVALID',
    );
  }
}
