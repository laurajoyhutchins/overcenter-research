import Overcenter.GraphTensor

namespace Overcenter

theorem certified_tensor_projection_is_aligned
    (ctx : RawClaimContext)
    (certified : CertifiedGraphTensor ctx) :
    tensorAligned certified.projection = true :=
  certified.aligned

theorem certified_tensor_projection_has_current_view_key
    (ctx : RawClaimContext)
    (certified : CertifiedGraphTensor ctx) :
    certified.projection.viewKey = graphViewKey (graphView ctx) :=
  certified.currentViewKey

theorem successful_tensor_projection_is_aligned
    (ctx : RawClaimContext)
    (projection : GraphTensorProjection)
    (built : buildGraphTensor ctx = some projection) :
    tensorAligned projection = true := by
  unfold buildGraphTensor at built
  cases certifiedResult : buildCertifiedGraphTensor ctx with
  | none =>
      simp [certifiedResult] at built
  | some certified =>
      simp [certifiedResult] at built
      cases built
      exact certified.aligned

theorem successful_tensor_projection_has_current_view_key
    (ctx : RawClaimContext)
    (projection : GraphTensorProjection)
    (built : buildGraphTensor ctx = some projection) :
    projection.viewKey = graphViewKey (graphView ctx) := by
  unfold buildGraphTensor at built
  cases certifiedResult : buildCertifiedGraphTensor ctx with
  | none =>
      simp [certifiedResult] at built
  | some certified =>
      simp [certifiedResult] at built
      cases built
      exact certified.currentViewKey

theorem verified_two_hop_requires_current_view_and_path
    (ctx : RawClaimContext)
    (viewKey sourceId targetId : String)
    (leftRelation rightRelation : GraphTensorRelation)
    (verified :
      verifyTypedTwoHop
        ctx viewKey sourceId targetId leftRelation rightRelation = true) :
    ∃ projection,
      buildGraphTensor ctx = some projection ∧
      projection.viewKey == viewKey = true ∧
      hasTypedTwoHop (graphView ctx)
        sourceId targetId leftRelation rightRelation = true := by
  unfold verifyTypedTwoHop at verified
  cases built : buildGraphTensor ctx with
  | none =>
      simp [built] at verified
  | some projection =>
      rw [built] at verified
      exact ⟨projection, built, Bool.and_eq_true.mp verified⟩

end Overcenter
