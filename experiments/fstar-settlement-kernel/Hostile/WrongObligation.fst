module Hostile.WrongObligation

open SettlementKernel
open Positive

let wrong_obligation_authority : settlement_authority = {
  obligation_id = 42;
  revision = 7;
  authority_generation = 3
}

[@@expect_failure]
let impossible : bound_authority obligation_a =
  wrong_obligation_authority
