module CapabilityConcurrency

#lang-pulse

open Pulse.Lib.Pervasives
open Pulse.Lib.Reference
open Pulse.Class.PtsTo
open Pulse.Lib.Par

// A provider mutation coordinate is represented by one mutable location.
// Exclusive points-to ownership is the mutation capability for that coordinate.

fn increment_coordinate (coordinate:ref int) (#before:erased int)
  requires pts_to coordinate before
  ensures pts_to coordinate (before + 1)
{
  let current = !coordinate;
  coordinate := current + 1;
}

// Positive control: disjoint mutation authority can be split across workers
// and recombined after parallel execution.
divergent
fn independent_parallel
  (left right:ref int)
  (#left_before #right_before:erased int)
  requires pts_to left left_before
  requires pts_to right right_before
  ensures pts_to left (left_before + 1)
  ensures pts_to right (right_before + 1)
{
  par
    (fun _ -> increment_coordinate left #left_before)
    (fun _ -> increment_coordinate right #right_before);
}

// Positive control: one mutation coordinate may be used twice when authority
// is transferred through an explicit order.
fn same_coordinate_sequential
  (coordinate:ref int)
  (#before:erased int)
  requires pts_to coordinate before
  ensures pts_to coordinate (before + 2)
{
  increment_coordinate coordinate #before;
  increment_coordinate coordinate #(before + 1);
}
