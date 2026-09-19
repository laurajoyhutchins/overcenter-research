module ChangedSemantics

open SettlementKernel
open Positive

let changed_verifier_key : material_key =
  { key_a with verifier_version = 12 }

let changed_source_key : material_key =
  { key_a with source_input = 102 }

let changed_config_key : material_key =
  { key_a with material_config = 203 }

let changed_predicate_key : material_key =
  { key_a with acceptance_predicate = 304 }

[@@expect_failure]
let verifier_change_cannot_reuse : bound_evidence obligation_a = {
  key = changed_verifier_key;
  producer = PriorRun
}

[@@expect_failure]
let source_change_cannot_reuse : bound_evidence obligation_a = {
  key = changed_source_key;
  producer = PriorRun
}

[@@expect_failure]
let config_change_cannot_reuse : bound_evidence obligation_a = {
  key = changed_config_key;
  producer = PriorRun
}

[@@expect_failure]
let predicate_change_cannot_reuse : bound_evidence obligation_a = {
  key = changed_predicate_key;
  producer = PriorRun
}
