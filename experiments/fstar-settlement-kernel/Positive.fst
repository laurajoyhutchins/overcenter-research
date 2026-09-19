module Positive

open SettlementKernel

let key_a : material_key = {
  obligation_id = 41;
  revision = 7;
  authority_generation = 3;
  verifier_version = 11;
  source_input = 101;
  material_config = 202;
  acceptance_predicate = 303
}

let obligation_a : obligation = { key = key_a }

let agent_evidence : bound_evidence obligation_a = {
  key = key_a;
  producer = Agent
}

let human_evidence : bound_evidence obligation_a = {
  key = key_a;
  producer = Human
}

let prior_run_evidence : bound_evidence obligation_a = {
  key = key_a;
  producer = PriorRun
}

let settled_from_agent : settlement =
  settle obligation_a agent_evidence

let settled_from_human : settlement =
  settle obligation_a human_evidence

let settled_from_prior_run : settlement =
  settle obligation_a prior_run_evidence

let raw_agent_evidence : evidence = {
  key = key_a;
  producer = Agent
}

let validated_agent_evidence : option (bound_evidence obligation_a) =
  validate obligation_a raw_agent_evidence
