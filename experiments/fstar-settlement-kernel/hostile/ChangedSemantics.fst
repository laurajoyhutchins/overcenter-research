module ChangedSemantics

open SettlementKernel
open Positive

let changed_key : material_key =
  { key_a with verifier_version = 12 }

let historical : evidence = {
  key = changed_key;
  producer = PriorRun
}

let impossible : bound_evidence obligation_a =
  historical
