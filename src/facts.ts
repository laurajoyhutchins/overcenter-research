import type {
  Data,
  Dependency,
  Disposition,
  Obligation,
  Observation,
  Postcondition,
  Run,
} from './model.ts';
import {
  validateObservationEnvelope,
} from './observation.ts';
import {
  validateCanonicalPostcondition,
  validatePostcondition,
} from './postconditions.ts';

export const LEGACY_OBLIGATION_SCHEMA='overcenter-git-obligation-v3' as const;
export const OBLIGATION_SCHEMA='overcenter-git-obligation-v4' as const;
export type ObligationSchema=
  | typeof LEGACY_OBLIGATION_SCHEMA
  | typeof OBLIGATION_SCHEMA;
export const CLAIM_SCHEMA='overcenter-git-claim-v3' as const;
export const EXECUTION_AUTHORITY_SCHEMA='overcenter-git-execution-authority-v1' as const;
export const EFFECT_RESERVATION_SCHEMA='overcenter-git-effect-reservation-v1' as const;
export const LEGACY_RECEIPT_SCHEMA='overcenter-git-receipt-v4' as const;
export const RECEIPT_SCHEMA='overcenter-git-receipt-v5' as const;
export type ReceiptSchema=typeof LEGACY_RECEIPT_SCHEMA|typeof RECEIPT_SCHEMA;

export interface ObligationInput {
  id:string;
  dependencies?:Dependency[];
  packet?:Data;
  postcondition:Postcondition;
}

export interface State {
  obligations:Record<string,Obligation>;
  definition_commits:Record<string,string>;
}

export type ObligationFact =
  | {
      schema:ObligationSchema;
      kind:'defined';
      obligation:Obligation;
    }
  | {
      schema:ObligationSchema;
      kind:'amended';
      obligation:Obligation;
      previous_definition_commit:string;
    };

export interface ClaimFact {
  schema:typeof CLAIM_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  obligation_key:string;
  execution_capability_sha256:string;
}

export interface ExecutionAuthorityFact {
  schema:typeof EXECUTION_AUTHORITY_SCHEMA;
  run_id:string;
  obligation_id:string;
  generation:number;
  previous_authority_commit:string;
  execution_capability_sha256:string;
}

export interface EffectReservationFact {
  schema:typeof EFFECT_RESERVATION_SCHEMA;
  run_id:string;
  obligation_id:string;
  execution_generation:number;
  execution_authority_commit:string;
}

export interface EffectReservation extends EffectReservationFact {
  reservation_commit:string;
}

export type ReceiptKind='observation'|'judgment-required'|'execution-terminated';

export interface ReceiptFact {
  schema:ReceiptSchema;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  claim_commit:string;
  execution_generation:number;
  execution_authority_commit:string;
  kind:ReceiptKind;
  observed:Observation|null;
  diagnostic?:Data;
  settled_at:string;
}

export interface Receipt extends ReceiptFact {
  disposition:Disposition;
  verified:boolean;
  settlement_commit?:string;
}

export interface HistoricalRun extends Run {
  obligation:Obligation;
  definition_commit:string;
}

export interface FactCommit {
  commit:string;
  parent:string|null;
  obligation?:unknown|null;
  claim?:unknown|null;
  execution_authority?:unknown|null;
  effect_reservation?:unknown|null;
  receipt?:unknown|null;
}

export function emptyState():State {
  return {obligations:{},definition_commits:{}};
}

function data(value:unknown):value is Data {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function exactKeys(
  value:Record<string,unknown>,
  required:readonly string[],
  optional:readonly string[]=[],
  error='INVALID_FACT_SHAPE',
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

function positiveSafeInteger(value:unknown,error:string):asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number)<1) throw new Error(error);
}

function sha256Hex(value:unknown,error:string):asserts value is string {
  if (typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(error);
}

export function validateDependencies(dependencies:Dependency[]):void {
  for (const edge of dependencies) {
    if (!data(edge)) throw new Error('INVALID_DEPENDENCY');
    if (edge.kind==='control') {
      exactKeys(edge,['kind','upstream'],[],'INVALID_DEPENDENCY');
      nonEmptyString(edge.upstream,'INVALID_DEPENDENCY');
      continue;
    }
    if (edge.kind!=='semantic') throw new Error('INVALID_DEPENDENCY');
    exactKeys(edge,['kind','upstream','consumes'],[],'INVALID_DEPENDENCY');
    nonEmptyString(edge.upstream,'INVALID_DEPENDENCY');
    if (!data(edge.consumes)) throw new Error('INVALID_DEPENDENCY');
    exactKeys(edge.consumes,['kind','selector'],[],'INVALID_DEPENDENCY_CONSUMES');
    if (!['output','evidence'].includes(String(edge.consumes.kind))) {
      throw new Error('INVALID_DEPENDENCY');
    }
    nonEmptyString(edge.consumes.selector,'INVALID_DEPENDENCY');
  }
}

export function normalizeObligation(input:ObligationInput):Obligation {
  if (!input || typeof input.id!=='string' || input.id.length===0) {
    throw new Error('INVALID_OBLIGATION_ID');
  }
  validateCanonicalPostcondition(input.postcondition);
  const dependencies:Dependency[]=structuredClone(input.dependencies??[]);
  validateDependencies(dependencies);
  return {
    id:input.id,
    dependencies,
    packet:structuredClone(input.packet??{}),
    postcondition:structuredClone(input.postcondition),
  };
}

export function validateStoredObligation(
  obligation:Obligation,
  {canonicalPostcondition=true}:{canonicalPostcondition?:boolean}={},
):Obligation {
  if (!data(obligation)) throw new Error('INVALID_OBLIGATION');
  const raw=obligation as unknown as Record<string,unknown>;
  if ('deps' in raw) throw new Error('LEGACY_DEPENDENCY_PROJECTION_UNSUPPORTED');
  exactKeys(raw,['id','dependencies','packet','postcondition'],[],'INVALID_OBLIGATION');
  nonEmptyString(obligation.id,'INVALID_OBLIGATION_ID');
  if (!Array.isArray(obligation.dependencies)) throw new Error('INVALID_DEPENDENCIES');
  if (!data(raw.packet)) throw new Error('INVALID_PACKET');
  validateDependencies(obligation.dependencies);
  if (canonicalPostcondition) {
    validateCanonicalPostcondition(obligation.postcondition);
  } else {
    validatePostcondition(obligation.postcondition);
  }
  return structuredClone(obligation);
}

export function validateObligationFact(value:unknown):ObligationFact {
  if (!data(value)) throw new Error('INVALID_OBLIGATION_FACT');
  if (
    value.schema!==LEGACY_OBLIGATION_SCHEMA
    && value.schema!==OBLIGATION_SCHEMA
  ) {
    throw new Error('INVALID_OBLIGATION_SCHEMA');
  }
  const schema=value.schema;
  const canonicalPostcondition=schema===OBLIGATION_SCHEMA;
  if (value.kind==='defined') {
    exactKeys(value,['schema','kind','obligation'],[],'INVALID_OBLIGATION_FACT');
    return {
      schema,
      kind:'defined',
      obligation:validateStoredObligation(
        value.obligation as Obligation,
        {canonicalPostcondition},
      ),
    };
  }
  if (value.kind==='amended') {
    exactKeys(
      value,
      ['schema','kind','obligation','previous_definition_commit'],
      [],
      'INVALID_OBLIGATION_FACT',
    );
    nonEmptyString(
      value.previous_definition_commit,
      'INVALID_PREVIOUS_DEFINITION_COMMIT',
    );
    return {
      schema,
      kind:'amended',
      obligation:validateStoredObligation(
        value.obligation as Obligation,
        {canonicalPostcondition},
      ),
      previous_definition_commit:value.previous_definition_commit,
    };
  }
  throw new Error('INVALID_OBLIGATION_KIND');
}

export function validateClaimFact(value:unknown):ClaimFact {
  if (!data(value)) throw new Error('INVALID_CLAIM_FACT');
  exactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'claimed_revision',
    'obligation_key',
    'execution_capability_sha256',
  ],[],'INVALID_CLAIM_FACT');
  if (value.schema!==CLAIM_SCHEMA) throw new Error('INVALID_CLAIM_SCHEMA');
  nonEmptyString(value.run_id,'INVALID_RUN_ID');
  nonEmptyString(value.obligation_id,'INVALID_OBLIGATION_ID');
  nonEmptyString(value.claimed_revision,'INVALID_CLAIMED_REVISION');
  nonEmptyString(value.obligation_key,'INVALID_OBLIGATION_KEY');
  sha256Hex(
    value.execution_capability_sha256,
    'INVALID_EXECUTION_CAPABILITY_DIGEST',
  );
  return structuredClone(value) as unknown as ClaimFact;
}

export function validateExecutionAuthorityFact(value:unknown):ExecutionAuthorityFact {
  if (!data(value)) throw new Error('INVALID_EXECUTION_AUTHORITY_FACT');
  exactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'generation',
    'previous_authority_commit',
    'execution_capability_sha256',
  ],[],'INVALID_EXECUTION_AUTHORITY_FACT');
  if (value.schema!==EXECUTION_AUTHORITY_SCHEMA) {
    throw new Error('INVALID_EXECUTION_AUTHORITY_SCHEMA');
  }
  nonEmptyString(value.run_id,'INVALID_RUN_ID');
  nonEmptyString(value.obligation_id,'INVALID_OBLIGATION_ID');
  positiveSafeInteger(value.generation,'INVALID_EXECUTION_GENERATION');
  nonEmptyString(
    value.previous_authority_commit,
    'INVALID_PREVIOUS_AUTHORITY_COMMIT',
  );
  sha256Hex(
    value.execution_capability_sha256,
    'INVALID_EXECUTION_CAPABILITY_DIGEST',
  );
  return structuredClone(value) as unknown as ExecutionAuthorityFact;
}

export function validateEffectReservationFact(value:unknown):EffectReservationFact {
  if (!data(value)) throw new Error('INVALID_EFFECT_RESERVATION_FACT');
  exactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'execution_generation',
    'execution_authority_commit',
  ],[],'INVALID_EFFECT_RESERVATION_FACT');
  if (value.schema!==EFFECT_RESERVATION_SCHEMA) {
    throw new Error('INVALID_EFFECT_RESERVATION_SCHEMA');
  }
  nonEmptyString(value.run_id,'INVALID_RUN_ID');
  nonEmptyString(value.obligation_id,'INVALID_OBLIGATION_ID');
  positiveSafeInteger(value.execution_generation,'INVALID_EXECUTION_GENERATION');
  nonEmptyString(
    value.execution_authority_commit,
    'INVALID_EXECUTION_AUTHORITY_COMMIT',
  );
  return structuredClone(value) as unknown as EffectReservationFact;
}

export function validateReceiptFact(value:unknown):ReceiptFact {
  if (!data(value)) throw new Error('INVALID_RECEIPT_FACT');
  exactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'claimed_revision',
    'claim_commit',
    'execution_generation',
    'execution_authority_commit',
    'kind',
    'observed',
    'settled_at',
  ],['diagnostic'],'INVALID_RECEIPT_FACT');
  if (
    value.schema!==RECEIPT_SCHEMA
    && value.schema!==LEGACY_RECEIPT_SCHEMA
  ) {
    throw new Error('INVALID_RECEIPT_SCHEMA');
  }
  nonEmptyString(value.run_id,'INVALID_RUN_ID');
  nonEmptyString(value.obligation_id,'INVALID_OBLIGATION_ID');
  nonEmptyString(value.claimed_revision,'INVALID_CLAIMED_REVISION');
  nonEmptyString(value.claim_commit,'INVALID_CLAIM_COMMIT');
  positiveSafeInteger(value.execution_generation,'INVALID_EXECUTION_GENERATION');
  nonEmptyString(
    value.execution_authority_commit,
    'INVALID_EXECUTION_AUTHORITY_COMMIT',
  );
  if (!['observation','judgment-required','execution-terminated'].includes(String(value.kind))) {
    throw new Error('INVALID_RECEIPT_KIND');
  }
  if (value.observed!==null && !data(value.observed)) {
    throw new Error('INVALID_RECEIPT_OBSERVATION');
  }
  if (value.schema===RECEIPT_SCHEMA && value.observed!==null) {
    validateObservationEnvelope(value.observed);
  }
  if (value.diagnostic!==undefined && !data(value.diagnostic)) {
    throw new Error('INVALID_RECEIPT_DIAGNOSTIC');
  }
  nonEmptyString(value.settled_at,'INVALID_SETTLED_AT');
  return structuredClone(value) as unknown as ReceiptFact;
}

export type AuthorityFact =
  | ObligationFact
  | ClaimFact
  | ExecutionAuthorityFact
  | EffectReservationFact
  | ReceiptFact;

export function validateAuthorityFact(value:unknown):AuthorityFact {
  if (!data(value)) throw new Error('INVALID_AUTHORITY_FACT');
  switch (value.schema) {
    case LEGACY_OBLIGATION_SCHEMA:
    case OBLIGATION_SCHEMA:
      return validateObligationFact(value);
    case CLAIM_SCHEMA:
      return validateClaimFact(value);
    case EXECUTION_AUTHORITY_SCHEMA:
      return validateExecutionAuthorityFact(value);
    case EFFECT_RESERVATION_SCHEMA:
      return validateEffectReservationFact(value);
    case LEGACY_RECEIPT_SCHEMA:
    case RECEIPT_SCHEMA:
      return validateReceiptFact(value);
    default:
      throw new Error('UNKNOWN_AUTHORITY_FACT_SCHEMA');
  }
}
