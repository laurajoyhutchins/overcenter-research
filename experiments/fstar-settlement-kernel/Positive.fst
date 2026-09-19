module Positive

open SettlementKernel

let semantic_a : semantic_key = {
  verifier_version = 11;
  source_input = 101;
  material_config = 202;
  acceptance_predicate = 303;
  semantic_dependencies = 404
}

let obligation_a : obligation = {
  obligation_id = 41;
  semantic = semantic_a;
  revision = 7;
  authority_generation = 3
}

let obligation_a_rotated : obligation = {
  obligation_id = 41;
  semantic = semantic_a;
  revision = 8;
  authority_generation = 4
}

let obligation_b_same_semantics : obligation = {
  obligation_id = 42;
  semantic = semantic_a;
  revision = 1;
  authority_generation = 1
}

let agent_realization : realization = {
  semantic = semantic_a;
  producer = Agent
}

let human_realization : realization = {
  semantic = semantic_a;
  producer = Human
}

let prior_run_realization : realization = {
  semantic = semantic_a;
  producer = PriorRun
}

let authority_a : bound_authority obligation_a = {
  obligation_id = 41;
  revision = 7;
  authority_generation = 3
}

let authority_a_rotated : bound_authority obligation_a_rotated = {
  obligation_id = 41;
  revision = 8;
  authority_generation = 4
}

let authority_b : bound_authority obligation_b_same_semantics = {
  obligation_id = 42;
  revision = 1;
  authority_generation = 1
}

let agent_for_a : bound_realization obligation_a =
  agent_realization

let human_for_a : bound_realization obligation_a =
  human_realization

let prior_for_a : bound_realization obligation_a =
  prior_run_realization

let prior_for_rotated_a : bound_realization obligation_a_rotated =
  prior_run_realization

let prior_for_b : bound_realization obligation_b_same_semantics =
  prior_run_realization

let settled_from_agent : settlement =
  settle obligation_a agent_for_a authority_a

let settled_from_human : settlement =
  settle obligation_a human_for_a authority_a

let settled_from_prior_run : settlement =
  settle obligation_a prior_for_a authority_a

let settled_after_authority_rotation : settlement =
  settle obligation_a_rotated prior_for_rotated_a authority_a_rotated

let settled_distinct_obligation_same_semantics : settlement =
  settle obligation_b_same_semantics prior_for_b authority_b

let validated_prior_for_rotated
  : option (bound_realization obligation_a_rotated)
  =
  validate_realization obligation_a_rotated prior_run_realization
