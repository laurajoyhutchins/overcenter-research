export type TransactionAdmission =
  | {command:'mutate';current_authority:boolean;exact_revision:boolean;unresolved_effect:boolean}
  | {command:'settle';current_authority:boolean;exact_revision:boolean;verified_present:boolean;verified_exact_revision:boolean}
  | {command:'replay';current_authority:boolean;exact_revision:boolean;verified_absent:boolean;verified_exact_revision:boolean}
  | {command:'done';settlement_completed:boolean;settlement_was_authorized:boolean;settlement_evidence_matches:boolean;verified_present:boolean;verified_exact_revision:boolean;evidence_valid:boolean};

export function transactionAdmitted(s:TransactionAdmission):boolean {
  switch(s.command){
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
