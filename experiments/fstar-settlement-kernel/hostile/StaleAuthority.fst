module hostile.StaleAuthority

open SettlementKernel
open Positive

let stale_key : material_key =
  { key_a with authority_generation = 2 }

let stale : evidence = {
  key = stale_key;
  producer = Human
}

[@@expect_failure]
let impossible : bound_evidence obligation_a =
  stale
