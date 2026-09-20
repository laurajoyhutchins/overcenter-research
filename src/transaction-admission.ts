export interface TransactionAdmission {
  current_authority:boolean;
  exact_revision:boolean;
  unresolved_effect:boolean;
  verified_present:boolean;
  verified_absent:boolean;
  verified_exact_revision:boolean;
  settlement_completed:boolean;
  settlement_was_authorized:boolean;
  settlement_evidence_matches:boolean;
  evidence_valid:boolean;
}

export type TransactionCommand='mutate'|'settle'|'replay'|'done';

export function transactionAdmitted(
  s:TransactionAdmission,
  command:TransactionCommand,
):boolean {
  switch(command){
    case 'mutate':
      return s.current_authority && s.exact_revision && !s.unresolved_effect;
    case 'settle':
      return s.current_authority && s.exact_revision &&
        s.verified_present && s.verified_exact_revision;
    case 'replay':
      return s.current_authority && s.exact_revision &&
        s.verified_absent && s.verified_exact_revision;
    case 'done':
      return s.settlement_completed && s.settlement_was_authorized &&
        s.settlement_evidence_matches && s.verified_present &&
        s.verified_exact_revision && s.evidence_valid;
  }
}
