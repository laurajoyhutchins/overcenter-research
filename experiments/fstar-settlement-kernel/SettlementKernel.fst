module SettlementKernel

type producer =
  | Agent
  | Human
  | PriorRun

type material_key = {
  obligation_id: nat;
  revision: nat;
  authority_generation: nat;
  verifier_version: nat;
  source_input: nat;
  material_config: nat;
  acceptance_predicate: nat
}

type obligation = {
  key: material_key
}

type evidence = {
  key: material_key;
  producer: producer
}

let compatible (o:obligation) (e:evidence) : bool =
  e.key = o.key

type bound_evidence (o:obligation) =
  e:evidence { compatible o e }

type settlement = {
  settled_key: material_key;
  evidence_producer: producer
}

let validate (o:obligation) (e:evidence)
  : Tot (option (bound_evidence o))
  = if compatible o e
    then Some e
    else None

let settle (o:obligation) (e:bound_evidence o)
  : Tot settlement
  = {
      settled_key = o.key;
      evidence_producer = e.producer
    }

let reattribute
    (o:obligation)
    (e:bound_evidence o)
    (p:producer)
  : Tot (bound_evidence o)
  = { e with producer = p }
