import type {
  Data,
  Dependency,
  ReceiptDisposition,
  Obligation,
  Observation,
  Postcondition,
  Run,
} from './model.ts';
import { validatePostcondition } from './observation.ts';

export const OBLIGATION_SCHEMA='overcenter-git-obligation-v3' as const;
export const CLAIM_SCHEMA='overcenter-git-claim-v2' as const;
export const RECEIPT_SCHEMA='overcenter-git-receipt-v3' as const;

export interface ObligationInput {
  id:string;
  dependencies?:Dependency[];
  packet?:Data;
  postcondition:Postcondition;
}

export interface ObligationCatalog {
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
}

export type ReceiptKind='observation'|'judgment-required'|'execution-terminated';

export interface ReceiptFact {
  schema:typeof RECEIPT_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  claim_commit:string;
  kind:ReceiptKind;
  observed:Observation|null;
  diagnostic?:Data;
  settled_at:string;
}

export interface Receipt extends ReceiptFact {
  disposition:ReceiptDisposition;
  verified:boolean;
  settlement_commit?:string;
}

export interface RunRecord extends Run {
  obligation:Obligation;
  definition_commit:string;
}

export interface FactCommit {
  commit:string;
  parent:string|null;
  obligation?:unknown|null;
  claim?:unknown|null;
  receipt?:unknown|null;
}

export function emptyObligationCatalog():ObligationCatalog {
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
  return {
    id:input.id,
    dependencies,
    packet:structuredClone(input.packet??{}),
    postcondition:structuredClone(input.postcondition),
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
  return structuredClone(obligation);
}
