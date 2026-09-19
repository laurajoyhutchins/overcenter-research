import { canonicalDigest, sha256 } from './digest.ts';

export const VERIFIED_REALIZATION_SCHEMA='overcenter-verified-realization-v1' as const;
export const REALIZATION_KEY_SCHEMA='overcenter-realization-key-v1' as const;

export type ReuseMode='content-addressed'|'external-effect';

export interface SemanticDependencyIdentity {
  selector:string;
  identity:string;
}

export interface AcceptancePredicate {
  kind:'sha256-equals/v1';
  expected_sha256:string;
  [key:string]:unknown;
}

export interface RealizationContract {
  packet:unknown;
  semantic_dependencies:SemanticDependencyIdentity[];
  verifier_identity:string;
  material_configuration:unknown;
  source_inputs:unknown;
  acceptance_predicate:AcceptancePredicate;
  reuse_mode:ReuseMode;
}

export interface RealizationCandidate {
  producer:
    | {kind:'agent';id:string}
    | {kind:'human';id:string}
    | {kind:'previous-run';id:string};
  content:string;
}

export interface VerifiedRealizationFact {
  schema:typeof VERIFIED_REALIZATION_SCHEMA;
  obligation_key:string;
  realization_identity:string;
  evidence:{
    verifier_identity:string;
    acceptance_predicate_digest:string;
    output_sha256:string;
  };
}

export type ReuseDecision =
  | {
      satisfied:true;
      reason:'REUSED_VERIFIED_REALIZATION';
      obligation_key:string;
      realization:VerifiedRealizationFact;
    }
  | {
      satisfied:false;
      reason:'NO_MATCHING_REALIZATION'|'CURRENT_OBSERVATION_REQUIRED';
      obligation_key:string;
    };

function sortedSemanticDependencies(
  dependencies:SemanticDependencyIdentity[],
):SemanticDependencyIdentity[] {
  return dependencies
    .map(dependency=>structuredClone(dependency))
    .sort((a,b)=>canonicalDigest(a).localeCompare(canonicalDigest(b)));
}

function validateDigest(value:string,label:string):void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}_INVALID`);
}

export function realizationObligationKey(contract:RealizationContract):string {
  if (!contract.verifier_identity) throw new Error('VERIFIER_IDENTITY_REQUIRED');
  validateDigest(contract.acceptance_predicate.expected_sha256,'ACCEPTANCE_SHA256');
  return canonicalDigest({
    schema:REALIZATION_KEY_SCHEMA,
    packet:contract.packet,
    semantic_dependencies:sortedSemanticDependencies(contract.semantic_dependencies),
    verifier_identity:contract.verifier_identity,
    material_configuration:contract.material_configuration,
    source_inputs:contract.source_inputs,
    acceptance_predicate:contract.acceptance_predicate,
    reuse_mode:contract.reuse_mode,
  });
}

export function verifyRealizationCandidate(
  contract:RealizationContract,
  candidate:RealizationCandidate,
):VerifiedRealizationFact {
  if (contract.reuse_mode!=='content-addressed') {
    throw new Error('EXTERNAL_EFFECT_NOT_REUSABLE');
  }
  if (contract.acceptance_predicate.kind!=='sha256-equals/v1') {
    throw new Error('UNSUPPORTED_ACCEPTANCE_PREDICATE');
  }

  const outputSha256=sha256(candidate.content);
  if (outputSha256!==contract.acceptance_predicate.expected_sha256) {
    throw new Error('REALIZATION_REJECTED');
  }

  // Producer identity is intentionally absent from the semantic fact. It can
  // be recorded separately as audit provenance, but it cannot change whether
  // this realization satisfies the obligation.
  return {
    schema:VERIFIED_REALIZATION_SCHEMA,
    obligation_key:realizationObligationKey(contract),
    realization_identity:`sha256:${outputSha256}`,
    evidence:{
      verifier_identity:contract.verifier_identity,
      acceptance_predicate_digest:canonicalDigest(contract.acceptance_predicate),
      output_sha256:outputSha256,
    },
  };
}

function factMatchesContract(
  fact:VerifiedRealizationFact,
  contract:RealizationContract,
  obligationKey:string,
):boolean {
  if (fact.schema!==VERIFIED_REALIZATION_SCHEMA) return false;
  if (fact.obligation_key!==obligationKey) return false;
  if (fact.evidence.verifier_identity!==contract.verifier_identity) return false;
  if (
    fact.evidence.acceptance_predicate_digest
    !==canonicalDigest(contract.acceptance_predicate)
  ) return false;
  if (fact.evidence.output_sha256!==contract.acceptance_predicate.expected_sha256) {
    return false;
  }
  return fact.realization_identity===`sha256:${fact.evidence.output_sha256}`;
}

export function reusableRealization(
  contract:RealizationContract,
  facts:Iterable<VerifiedRealizationFact>,
):ReuseDecision {
  const obligationKey=realizationObligationKey(contract);
  if (contract.reuse_mode==='external-effect') {
    return {
      satisfied:false,
      reason:'CURRENT_OBSERVATION_REQUIRED',
      obligation_key:obligationKey,
    };
  }

  for (const fact of facts) {
    if (factMatchesContract(fact,contract,obligationKey)) {
      return {
        satisfied:true,
        reason:'REUSED_VERIFIED_REALIZATION',
        obligation_key:obligationKey,
        realization:fact,
      };
    }
  }
  return {
    satisfied:false,
    reason:'NO_MATCHING_REALIZATION',
    obligation_key:obligationKey,
  };
}
