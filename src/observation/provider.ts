import {
  assertExactKeys as exactKeys,
  assertNonEmptyString as nonEmptyString,
  isData as data,
} from '../validation.ts';

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
}

export interface ProviderObservationValidationOptions {
  requiredNonEmptyTopLevel?:readonly string[];
}

const shape=(
  value:unknown,
  required:readonly string[],
  optional:readonly string[],
  error:string,
):Record<string,unknown>=>{
  if (!data(value)) throw new Error(error);
  exactKeys(value,required,optional,error);
  return value;
};

const digest=(value:unknown,error:string)=>{
  if (typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(error);
};

export function validateProviderObservationEnvelope(
  value:unknown,
  {requiredNonEmptyTopLevel=[]}:ProviderObservationValidationOptions={},
):asserts value is ProviderObservation<string,unknown,unknown> {
  const top=shape(
    value,
    ['contract','observer','observed_at','request','response','outcome',...requiredNonEmptyTopLevel],
    ['structural_validation'],
    'PROVIDER_OBSERVATION_SHAPE_INVALID',
  );
  for (const name of requiredNonEmptyTopLevel) {
    nonEmptyString(top[name],`PROVIDER_OBSERVATION_EXTENSION_INVALID:${name}`);
  }

  const contract=shape(
    top.contract,
    ['provider','api_version','operation_id','schema_sha256'],
    [],
    'PROVIDER_OBSERVATION_CONTRACT_SHAPE_INVALID',
  );
  nonEmptyString(contract.provider,'PROVIDER_OBSERVATION_PROVIDER_INVALID');
  nonEmptyString(contract.api_version,'PROVIDER_OBSERVATION_API_VERSION_INVALID');
  nonEmptyString(contract.operation_id,'PROVIDER_OBSERVATION_OPERATION_ID_INVALID');
  digest(contract.schema_sha256,'PROVIDER_OBSERVATION_SCHEMA_DIGEST_INVALID');

  const observer=shape(top.observer,['kind','id'],[],'PROVIDER_OBSERVATION_OBSERVER_SHAPE_INVALID');
  nonEmptyString(observer.kind,'PROVIDER_OBSERVATION_OBSERVER_KIND_INVALID');
  nonEmptyString(observer.id,'PROVIDER_OBSERVATION_OBSERVER_ID_INVALID');
  nonEmptyString(top.observed_at,'PROVIDER_OBSERVATION_TIME_INVALID');
  if (!data(top.request)) throw new Error('PROVIDER_OBSERVATION_REQUEST_INVALID');
  if (!data(top.response)) throw new Error('PROVIDER_OBSERVATION_RESPONSE_INVALID');

  const outcome=shape(
    top.outcome,
    ['status','visibility'],
    ['value','transport_error'],
    'PROVIDER_OBSERVATION_OUTCOME_SHAPE_INVALID',
  );
  if (!Number.isSafeInteger(outcome.status) || Number(outcome.status)<0) {
    throw new Error('PROVIDER_OBSERVATION_STATUS_INVALID');
  }
  if (!['observed','not-observed','indeterminate'].includes(String(outcome.visibility))) {
    throw new Error('PROVIDER_OBSERVATION_VISIBILITY_INVALID');
  }
  if (outcome.transport_error!==undefined) {
    nonEmptyString(outcome.transport_error,'PROVIDER_OBSERVATION_TRANSPORT_ERROR_INVALID');
  }

  if (top.structural_validation!==undefined) {
    const structural=shape(
      top.structural_validation,
      ['operation_id','status','validated_paths','optional_absent_paths','schema_sha256'],
      [],
      'PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_SHAPE_INVALID',
    );
    nonEmptyString(structural.operation_id,'PROVIDER_OBSERVATION_STRUCTURAL_OPERATION_INVALID');
    nonEmptyString(structural.status,'PROVIDER_OBSERVATION_STRUCTURAL_STATUS_INVALID');
    const paths=(value:unknown)=>Array.isArray(value) && value.every(path=>typeof path==='string');
    if (!paths(structural.validated_paths) || !paths(structural.optional_absent_paths)) {
      throw new Error('PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_INVALID');
    }
    digest(structural.schema_sha256,'PROVIDER_OBSERVATION_STRUCTURAL_VALIDATION_INVALID');
  }
}
