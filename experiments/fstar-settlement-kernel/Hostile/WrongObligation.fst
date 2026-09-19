module Hostile.WrongObligation

open SettlementKernel
open Positive

let wrong_key : material_key =
  { key_a with obligation_id = 42 }

let forged : evidence = {
  key = wrong_key;
  producer = Agent
}

[@@expect_failure]
let impossible : bound_evidence obligation_a =
  forged
