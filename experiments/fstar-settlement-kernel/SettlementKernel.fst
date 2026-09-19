module SettlementKernel

type producer =
  | Agent
  | Human
  | PriorRun

type semantic_key = {
  verifier_version: nat;
  source_input: nat;
  material_config: nat;
  acceptance_predicate: nat;
  semantic_dependencies: nat
}

type obligation = {
  obligation_id: nat;
  semantic: semantic_key;
  revision: nat;
  authority_generation: nat
}

type realization = {
  semantic: semantic_key;
  producer: producer
}

let realization_compatible (o:obligation) (r:realization) : bool =
  r.semantic = o.semantic

type bound_realization (o:obligation) =
  r:realization { realization_compatible o r }

type settlement_authority = {
  obligation_id: nat;
  revision: nat;
  authority_generation: nat
}

let authority_current
  (o:obligation)
  (a:settlement_authority)
  : bool
  =
  a.obligation_id = o.obligation_id
  && a.revision = o.revision
  && a.authority_generation = o.authority_generation

type bound_authority (o:obligation) =
  a:settlement_authority { authority_current o a }

type settlement = {
  settled_obligation_id: nat;
  settled_revision: nat;
  settled_authority_generation: nat;
  realization_producer: producer;
  realization_semantic: semantic_key
}

let validate_realization
  (o:obligation)
  (r:realization)
  : Tot (option (bound_realization o))
  = if realization_compatible o r
    then Some r
    else None

let validate_authority
  (o:obligation)
  (a:settlement_authority)
  : Tot (option (bound_authority o))
  = if authority_current o a
    then Some a
    else None

let settle
  (o:obligation)
  (r:bound_realization o)
  (a:bound_authority o)
  : Tot settlement
  = {
      settled_obligation_id = o.obligation_id;
      settled_revision = a.revision;
      settled_authority_generation = a.authority_generation;
      realization_producer = r.producer;
      realization_semantic = r.semantic
    }
