export interface EffectSemantics {
  resource:string;
  desired:string;
}

export interface SettlementSemantics {
  verifier:string;
  acceptedAbsenceEvidenceKinds:readonly string[];
}

export interface SettlementEquivalenceWitness {
  schema:'overcenter-settlement-equivalence-witness-v1';
  issuer_contract:'overcenter/provider-settlement-equivalence-issuer/v1';
  provider:string;
  verifier_contract:string;
  coordinate_contract:string;
  observation_contract:string;
  operation_class:string;
  provider_contract_digest:string;
  resource:string;
  operation:string;
  equivalence_class:'same-project-truth-under-observation-and-settlement';
  effect_semantics_digest:string;
  settlement_semantics_digest:string;
  witness_digest:string;
}
