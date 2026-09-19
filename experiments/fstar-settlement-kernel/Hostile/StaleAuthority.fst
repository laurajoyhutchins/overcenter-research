module Hostile.StaleAuthority

open SettlementKernel
open Positive

let stale_generation_authority : settlement_authority = {
  obligation_id = 41;
  revision = 8;
  authority_generation = 3
}

[@@expect_failure]
let impossible : bound_authority obligation_a_rotated =
  stale_generation_authority
