import Overcenter.GraphTensor

namespace Overcenter

theorem finalize_graph_tensor_success_is_aligned
    (candidate projection : GraphTensorProjection)
    (built : finalizeGraphTensor candidate = some projection) :
    tensorAligned projection = true := by
  unfold finalizeGraphTensor at built
  by_cases aligned : tensorAligned candidate
  · simp [aligned] at built
    cases built
    exact aligned
  · simp [aligned] at built

theorem successful_tensor_projection_is_aligned
    (ctx : RawClaimContext)
    (projection : GraphTensorProjection)
    (built : buildGraphTensor ctx = some projection) :
    tensorAligned projection = true := by
  unfold buildGraphTensor at built
  split at built
  · contradiction
  · split at built
    · contradiction
    · rename_i wellFormed uniqueEdges
      cases entriesResult :
          (graphView ctx).edges.mapM (tensorEntryFor (graphView ctx).nodeIds) with
      | none =>
          simp [entriesResult] at built
      | some entries =>
          simp [entriesResult] at built
          exact finalize_graph_tensor_success_is_aligned
            {
              viewKey := graphViewKey (graphView ctx)
              nodeIds := (graphView ctx).nodeIds
              entries
            }
            projection
            built

theorem successful_tensor_projection_has_current_view_key
    (ctx : RawClaimContext)
    (projection : GraphTensorProjection)
    (built : buildGraphTensor ctx = some projection) :
    projection.viewKey = graphViewKey (graphView ctx) := by
  unfold buildGraphTensor at built
  split at built
  · contradiction
  · split at built
    · contradiction
    · rename_i wellFormed uniqueEdges
      cases entriesResult :
          (graphView ctx).edges.mapM (tensorEntryFor (graphView ctx).nodeIds) with
      | none =>
          simp [entriesResult] at built
      | some entries =>
          simp [entriesResult, finalizeGraphTensor] at built
          split at built
          · cases built
            rfl
          · contradiction

theorem verified_two_hop_requires_current_view_and_path
    (ctx : RawClaimContext)
    (viewKey sourceId targetId : String)
    (leftRelation rightRelation : GraphTensorRelation)
    (verified :
      verifyTypedTwoHop
        ctx viewKey sourceId targetId leftRelation rightRelation = true) :
    ∃ projection,
      buildGraphTensor ctx = some projection ∧
      projection.viewKey = viewKey ∧
      hasTypedTwoHop (graphView ctx)
        sourceId targetId leftRelation rightRelation = true := by
  unfold verifyTypedTwoHop at verified
  cases built : buildGraphTensor ctx with
  | none =>
      simp [built] at verified
  | some projection =>
      simp [built] at verified
      exact ⟨projection, built, verified.1, verified.2⟩

private def dep
    (upstream : String)
    (kind : ClaimDependencyKind)
    (selector : Option SemanticSelector := none) : RawClaimDependency := {
  upstream
  kind
  selector
}

private def obligation
    (id : String)
    (dependencies : List RawClaimDependency := []) : RawClaimObligation := {
  id
  dependencies
}

private def lifecycle (id : String) : RawClaimLifecycleFact := {
  obligationId := id
  status := .unrealized
  runId := none
}

private def sampleContext : RawClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "a"
  obligations := [
    obligation "c",
    obligation "b" [dep "c" .control],
    obligation "a" [dep "b" .semantic (some .verifiedContent)]
  ]
  lifecycles := [lifecycle "a", lifecycle "b", lifecycle "c"]
  receipts := []
}

example :
    hasTypedTwoHop (graphView sampleContext)
      "a" "c" .semanticVerifiedContent .control = true := by decide

private def duplicateContext : RawClaimContext := {
  sampleContext with
  obligations := [
    obligation "c",
    obligation "b",
    obligation "a" [
      dep "b" .semantic (some .verifiedContent),
      dep "b" .semantic (some .verifiedContent)
    ]
  ]
}

example :
    uniqueGraphViewEdges (graphView duplicateContext).edges = false := by decide

private def cycleContext : RawClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "a"
  obligations := [
    obligation "a" [dep "b" .control],
    obligation "b" [dep "a" .control]
  ]
  lifecycles := [lifecycle "a", lifecycle "b"]
  receipts := []
}

example :
    (buildGraphTensor cycleContext).isSome = true := by decide

end Overcenter
