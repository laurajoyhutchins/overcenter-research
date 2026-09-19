import Overcenter.KeyPreimage

open Lean

namespace Overcenter

theorem key_preimage_ready_implies_semantic_inputs_resolved
    (ctx : RawClaimContext)
    (ready : keyPreimageReady ctx = true) :
    rawSemanticInputsResolved ctx = true := by
  simp [keyPreimageReady] at ready
  exact ready.1.2

theorem key_preimage_ready_implies_unique_semantic_dependencies
    (ctx : RawClaimContext)
    (ready : keyPreimageReady ctx = true) :
    semanticDependenciesUnique ctx = true := by
  simp [keyPreimageReady] at ready
  exact ready.2

theorem built_model_implies_semantic_inputs_resolved
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (consumed : List Json)
    (built : buildObligationKeyPreimageModel input results = some consumed) :
    rawSemanticInputsResolved input.context = true := by
  cases readyValue : keyPreimageReady input.context with
  | false =>
      simp [buildObligationKeyPreimageModel, readyValue] at built
  | true =>
      exact key_preimage_ready_implies_semantic_inputs_resolved
        input.context
        readyValue

theorem built_model_implies_unique_semantic_dependencies
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (consumed : List Json)
    (built : buildObligationKeyPreimageModel input results = some consumed) :
    semanticDependenciesUnique input.context = true := by
  cases readyValue : keyPreimageReady input.context with
  | false =>
      simp [buildObligationKeyPreimageModel, readyValue] at built
  | true =>
      exact key_preimage_ready_implies_unique_semantic_dependencies
        input.context
        readyValue

theorem built_preimage_has_exact_shape
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    ∃ consumed,
      buildObligationKeyPreimageModel input results = some consumed ∧
      bytes = serializeObligationKeyPreimage input consumed := by
  cases modelResult : buildObligationKeyPreimageModel input results with
  | none =>
      simp [buildObligationKeyPreimage, modelResult] at built
  | some consumed =>
      have bytesEq :
          serializeObligationKeyPreimage input consumed = bytes := by
        simpa [buildObligationKeyPreimage, modelResult] using built
      exact ⟨consumed, rfl, bytesEq.symm⟩

theorem built_preimage_implies_semantic_inputs_resolved
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    rawSemanticInputsResolved input.context = true := by
  obtain ⟨consumed, modelBuilt, _⟩ :=
    built_preimage_has_exact_shape input results bytes built
  exact built_model_implies_semantic_inputs_resolved
    input
    results
    consumed
    modelBuilt

theorem built_preimage_implies_unique_semantic_dependencies
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    semanticDependenciesUnique input.context = true := by
  obtain ⟨consumed, modelBuilt, _⟩ :=
    built_preimage_has_exact_shape input results bytes built
  exact built_model_implies_unique_semantic_dependencies
    input
    results
    consumed
    modelBuilt

private def leaf : RawClaimObligation := {
  id := "leaf"
  dependencies := []
}

private def leafContext : RawClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "leaf"
  obligations := [leaf]
  lifecycles := [{
    obligationId := "leaf"
    status := .unrealized
    runId := none
  }]
  receipts := []
}

example : keyPreimageReady leafContext = true := by decide
example : plannedIdentityHashBytes leafContext = some [] := by decide

end Overcenter
