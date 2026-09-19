export interface EffectSemantics {
  resource:string;
  desired:string;
}

export interface SettlementSemantics {
  verifier:string;
  acceptedAbsenceEvidenceKinds:readonly string[];
}

export interface EffectEquivalenceWitness {
  schema:'overcenter-effect-equivalence-certificate-v1';
  issuer_contract:'overcenter/provider-effect-equivalence-issuer/v1';
  provider:string;
  verifier_contract:string;
  coordinate_contract:string;
  observation_contract:string;
  operation_class:string;
  resource:string;
  operation:string;
  equivalence_class:string;
  effect_semantics_digest:string;
  settlement_semantics_digest:string;
  certificate_digest:string;
}
