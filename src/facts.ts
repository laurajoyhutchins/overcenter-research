import type {
  Data,
  Dependency,
  Disposition,
  Obligation,
  Observation,
  Postcondition,
  Run,
} from './model.ts';
import { validatePostcondition } from './observation.ts';
import { validateRealizationDeclaration } from './realization.ts';

export const OBLIGATION_SCHEMA='overcenter-git-obligation-v3' as const;
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
  realization?:Obligation['realization'];
}

export interface State {
  obligations:Record<string,Obligation>;
  definition_commits:Record<string,string>;
}

export type ObligationFact =
  | {
      schema:typeof OBLIGATION_SCHEMA;
      kind:'defined';
      obligation:Obligation;
    }
  | {
      schema:typeof OBLIGATION_SCHEMA;
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
  realization?:unknown|null;
}

export function emptyState():State {
  return {obligations:{},definition_commits:{}};
}

export function validateDependencies(dependencies:Dependency[]):void {
  for (const edge of dependencies) {
    if (!edge || typeof edge.upstream!=='string' || edge.upstream.length===0) {
      throw new Error('INVALID_DEPENDENCY');
    }
    if (edge.kind==='control') continue;
    if (
      edge.kind!=='semantic'
      || !edge.consumes
      || !['output','evidence'].includes(edge.consumes.kind)
      || typeof edge.consumes.selector!=='string'
      || edge.consumes.selector.length===0
    ) {
      throw new Error('INVALID_DEPENDENCY');
    }
  }
}

export function normalizeObligation(input:ObligationInput):Obligation {
  if (!input || typeof input.id!=='string' || input.id.length===0) {
    throw new Error('INVALID_OBLIGATION_ID');
  }
  validatePostcondition(input.postcondition);
  const dependencies:Dependency[]=structuredClone(input.dependencies??[]);
  validateDependencies(dependencies);
  const realization=input.realization==null
    ? undefined
    : validateRealizationDeclaration(input.realization);
  return {
    id:input.id,
    dependencies,
    packet:structuredClone(input.packet??{}),
    postcondition:structuredClone(input.postcondition),
    ...(realization?{realization}:{}),
  };
}

export function validateStoredObligation(obligation:Obligation):Obligation {
  if (!obligation || typeof obligation!=='object') throw new Error('INVALID_OBLIGATION');
  const raw=obligation as unknown as Record<string,unknown>;
  if ('deps' in raw) throw new Error('LEGACY_DEPENDENCY_PROJECTION_UNSUPPORTED');
  if (typeof obligation.id!=='string' || obligation.id.length===0) {
    throw new Error('INVALID_OBLIGATION_ID');
  }
  if (!Array.isArray(obligation.dependencies)) throw new Error('INVALID_DEPENDENCIES');
  if (!raw.packet || typeof raw.packet!=='object' || Array.isArray(raw.packet)) {
    throw new Error('INVALID_PACKET');
  }
  validateDependencies(obligation.dependencies);
  validatePostcondition(obligation.postcondition);
  if (obligation.realization!=null) validateRealizationDeclaration(obligation.realization);
  return structuredClone(obligation);
}
