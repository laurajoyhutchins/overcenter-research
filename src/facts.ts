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
  validatePostcondition,
} from './observation.ts';
import { canonicalDigest } from './digest.ts';
import {
  assertExactKeys as exactKeys,
  assertNonEmptyString as nonEmptyString,
  isData as data,
} from './validation.ts';

export const GRAPH_PATCH_SCHEMA='overcenter-graph-patch-v1' as const;
export const CLAIM_SCHEMA='overcenter-git-claim-v3' as const;
export const EXECUTION_AUTHORITY_SCHEMA='overcenter-git-execution-authority-v1' as const;
export const EFFECT_RESERVATION_SCHEMA='overcenter-git-effect-reservation-v1' as const;
export const RECEIPT_SCHEMA='overcenter-git-receipt-v5' as const;

export interface ObligationInput {
  id:string;
  dependencies?:Dependency[];
  packet?:Data;
  postcondition:Postcondition;
}

export interface ObligationDefinition {
  dependencies:Dependency[];
  packet:Data;
  postcondition:Postcondition;
}

export interface State {
  obligations:Record<string,Obligation>;
  definition_ids:Record<string,string>;
}

export interface DefinitionFact {
  id:string;
  definition:ObligationDefinition;
}

export interface BindingFact {
  node_id:string;
  definition_id:string;
}

export interface GraphPatchFact {
  schema:typeof GRAPH_PATCH_SCHEMA;
  definitions:DefinitionFact[];
  bindings:BindingFact[];
  retire:string[];
}

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
  schema:typeof RECEIPT_SCHEMA;
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
  definition_id:string;
}

export interface FactCommit {
  commit:string;
  parent:string|null;
  graph_patch?:unknown|null;
  claim?:unknown|null;
  execution_authority?:unknown|null;
  effect_reservation?:unknown|null;
  receipt?:unknown|null;
}

export function emptyState():State {
  return {obligations:{},definition_ids:{}};
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
  validatePostcondition(input.postcondition);
  const dependencies:Dependency[]=structuredClone(input.dependencies??[]);
  validateDependencies(dependencies);
  return {
    id:input.id,
    dependencies,
    packet:structuredClone(input.packet??{}),
    postcondition:structuredClone(input.postcondition),
  };
}

export function validateStoredObligation(obligation:Obligation):Obligation {
  if (!data(obligation)) throw new Error('INVALID_OBLIGATION');
  const raw=obligation as unknown as Record<string,unknown>;
  exactKeys(raw,['id','dependencies','packet','postcondition'],[],'INVALID_OBLIGATION');
  nonEmptyString(obligation.id,'INVALID_OBLIGATION_ID');
  if (!Array.isArray(obligation.dependencies)) throw new Error('INVALID_DEPENDENCIES');
  if (!data(raw.packet)) throw new Error('INVALID_PACKET');
  validateDependencies(obligation.dependencies);
  validatePostcondition(obligation.postcondition);
  return structuredClone(obligation);
}

export function obligationDefinition(
  obligation:Obligation,
):ObligationDefinition {
  const dependencies=structuredClone(obligation.dependencies)
    .sort((a,b)=>canonicalDigest(a).localeCompare(canonicalDigest(b)));
  return {
    dependencies,
    packet:structuredClone(obligation.packet),
    postcondition:structuredClone(obligation.postcondition),
  };
}

export function obligationDefinitionId(
  definition:ObligationDefinition,
):string {
  return canonicalDigest({
    domain:'overcenter-obligation-definition',
    definition,
  });
}

export function materializeObligation(
  nodeId:string,
  definition:ObligationDefinition,
):Obligation {
  return {
    id:nodeId,
    dependencies:structuredClone(definition.dependencies),
    packet:structuredClone(definition.packet),
    postcondition:structuredClone(definition.postcondition),
  };
}

export function validateStoredObligationDefinition(
  definition:ObligationDefinition,
):ObligationDefinition {
  if (!data(definition)) throw new Error('INVALID_OBLIGATION_DEFINITION');
  const raw=definition as unknown as Record<string,unknown>;
  exactKeys(
    raw,
    ['dependencies','packet','postcondition'],
    [],
    'INVALID_OBLIGATION_DEFINITION',
  );
  if (!Array.isArray(definition.dependencies)) throw new Error('INVALID_DEPENDENCIES');
  if (!data(raw.packet)) throw new Error('INVALID_PACKET');
  validateDependencies(definition.dependencies);
  validatePostcondition(definition.postcondition);
  const normalized=structuredClone(definition);
  normalized.dependencies.sort(
    (a,b)=>canonicalDigest(a).localeCompare(canonicalDigest(b)),
  );
  return normalized;
}

export function validateGraphPatchFact(value:unknown):GraphPatchFact {
  if (!data(value)) throw new Error('INVALID_GRAPH_PATCH');
  exactKeys(
    value,
    ['schema','definitions','bindings','retire'],
    [],
    'INVALID_GRAPH_PATCH',
  );
  if (value.schema!==GRAPH_PATCH_SCHEMA) throw new Error('INVALID_GRAPH_PATCH_SCHEMA');
  if (!Array.isArray(value.definitions)) throw new Error('INVALID_GRAPH_PATCH_DEFINITIONS');
  if (!Array.isArray(value.bindings)) throw new Error('INVALID_GRAPH_PATCH_BINDINGS');
  if (!Array.isArray(value.retire)) throw new Error('INVALID_GRAPH_PATCH_RETIRE');

  const definitions:DefinitionFact[]=[];
  const definitionIds=new Set<string>();
  for (const item of value.definitions) {
    if (!data(item)) throw new Error('INVALID_GRAPH_PATCH_DEFINITION');
    exactKeys(item,['id','definition'],[],'INVALID_GRAPH_PATCH_DEFINITION');
    sha256Hex(item.id,'INVALID_DEFINITION_ID');
    const definition=validateStoredObligationDefinition(
      item.definition as ObligationDefinition,
    );
    if (obligationDefinitionId(definition)!==item.id) {
      throw new Error('OBLIGATION_DEFINITION_ID_MISMATCH');
    }
    if (definitionIds.has(item.id)) throw new Error(`DUPLICATE_DEFINITION:${item.id}`);
    definitionIds.add(item.id);
    definitions.push({id:item.id,definition});
  }

  const bindings:BindingFact[]=[];
  const nodeIds=new Set<string>();
  for (const item of value.bindings) {
    if (!data(item)) throw new Error('INVALID_GRAPH_PATCH_BINDING');
    exactKeys(item,['node_id','definition_id'],[],'INVALID_GRAPH_PATCH_BINDING');
    nonEmptyString(item.node_id,'INVALID_OBLIGATION_ID');
    sha256Hex(item.definition_id,'INVALID_DEFINITION_ID');
    if (nodeIds.has(item.node_id)) throw new Error(`DUPLICATE_GRAPH_PATCH_ID:${item.node_id}`);
    nodeIds.add(item.node_id);
    bindings.push({node_id:item.node_id,definition_id:item.definition_id});
  }

  const retire:string[]=[];
  for (const id of value.retire) {
    nonEmptyString(id,'INVALID_OBLIGATION_ID');
    if (nodeIds.has(id)) throw new Error(`DUPLICATE_GRAPH_PATCH_ID:${id}`);
    nodeIds.add(id);
    retire.push(id);
  }

  if (bindings.length===0 && retire.length===0) throw new Error('EMPTY_GRAPH_PATCH');
  return {
    schema:GRAPH_PATCH_SCHEMA,
    definitions,
    bindings,
    retire,
  };
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
  if (value.schema!==RECEIPT_SCHEMA) {
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
  if (value.observed!==null) {
    validateObservationEnvelope(value.observed);
  }
  if (value.diagnostic!==undefined && !data(value.diagnostic)) {
    throw new Error('INVALID_RECEIPT_DIAGNOSTIC');
  }
  nonEmptyString(value.settled_at,'INVALID_SETTLED_AT');
  return structuredClone(value) as unknown as ReceiptFact;
}

export type AuthorityFact =
  | GraphPatchFact
  | ClaimFact
  | ExecutionAuthorityFact
  | EffectReservationFact
  | ReceiptFact;

export function validateAuthorityFact(value:unknown):AuthorityFact {
  if (!data(value)) throw new Error('INVALID_AUTHORITY_FACT');
  switch (value.schema) {
    case GRAPH_PATCH_SCHEMA:
      return validateGraphPatchFact(value);
    case CLAIM_SCHEMA:
      return validateClaimFact(value);
    case EXECUTION_AUTHORITY_SCHEMA:
      return validateExecutionAuthorityFact(value);
    case EFFECT_RESERVATION_SCHEMA:
      return validateEffectReservationFact(value);
    case RECEIPT_SCHEMA:
      return validateReceiptFact(value);
    default:
      throw new Error('UNKNOWN_AUTHORITY_FACT_SCHEMA');
  }
}
