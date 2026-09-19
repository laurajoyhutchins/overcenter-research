module HostileAlias

#lang-pulse

open Pulse.Lib.Pervasives
open Pulse.Lib.Reference
open Pulse.Class.PtsTo
open CapabilityConcurrency

// Hostile control: one exclusive capability cannot satisfy the two disjoint
// capabilities required by independent_parallel, even if both formal
// coordinates are supplied with the same concrete reference.
divergent
fn alias_one_coordinate_into_two_workers
  (coordinate:ref int)
  (#before:erased int)
  requires pts_to coordinate before
  ensures exists* after. pts_to coordinate after
{
  independent_parallel coordinate coordinate #before #before;
}
