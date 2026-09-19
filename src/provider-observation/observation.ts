// Provider-neutral evidence envelope only. Provider-specific identity, freshness,
// completeness, and negative-evidence semantics belong outside this module.
export type ObservationVisibility = 'observed' | 'not-observed' | 'indeterminate';

export interface ObservationObserver {
  kind: string;
  id: string;
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
}

export interface ProviderObservationValidationOptions {
  topLevelExtensions?: readonly string[];
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
    outcomeExtensions=[],
  }:ProviderObservationValidationOptions={},
):asserts value is ProviderObservation<string,unknown,unknown> {
  if (!data(value)) throw new Error('PROVIDER_OBSERVATION_INVALID');
  exactKeys(
    value,
    ['contract','observer','observed_at','request','response','outcome'],
    topLevelExtensions,
  );

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
}
