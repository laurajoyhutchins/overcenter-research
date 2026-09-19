module Hostile.ChangedSemantics

open SettlementKernel
open Positive

let changed_verifier : semantic_key =
  { semantic_a with verifier_version = 12 }

let changed_source : semantic_key =
  { semantic_a with source_input = 102 }

let changed_config : semantic_key =
  { semantic_a with material_config = 203 }

let changed_predicate : semantic_key =
  { semantic_a with acceptance_predicate = 304 }

let changed_dependencies : semantic_key =
  { semantic_a with semantic_dependencies = 405 }

[@@expect_failure]
let verifier_change_cannot_reuse : bound_realization obligation_a = {
  semantic = changed_verifier;
  producer = PriorRun
}

[@@expect_failure]
let source_change_cannot_reuse : bound_realization obligation_a = {
  semantic = changed_source;
  producer = PriorRun
}

[@@expect_failure]
let config_change_cannot_reuse : bound_realization obligation_a = {
  semantic = changed_config;
  producer = PriorRun
}

[@@expect_failure]
let predicate_change_cannot_reuse : bound_realization obligation_a = {
  semantic = changed_predicate;
  producer = PriorRun
}

[@@expect_failure]
let dependency_change_cannot_reuse : bound_realization obligation_a = {
  semantic = changed_dependencies;
  producer = PriorRun
}
