module Hostile.StaleRevision

open SettlementKernel
open Positive

let stale_revision_authority : settlement_authority = {
  obligation_id = 41;
  revision = 7;
  authority_generation = 4
}

[@@expect_failure]
let impossible : bound_authority obligation_a_rotated =
  stale_revision_authority
