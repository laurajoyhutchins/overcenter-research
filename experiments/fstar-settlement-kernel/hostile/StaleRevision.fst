module hostile.StaleRevision

open SettlementKernel
open Positive

let stale_key : material_key =
  { key_a with revision = 6 }

let stale : evidence = {
  key = stale_key;
  producer = PriorRun
}

[@@expect_failure]
let impossible : bound_evidence obligation_a =
  stale
