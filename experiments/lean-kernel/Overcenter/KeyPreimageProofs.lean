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

theorem built_preimage_implies_semantic_inputs_resolved
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    rawSemanticInputsResolved input.context = true := by
  cases readyValue : keyPreimageReady input.context with
  | false =>
      simp [buildObligationKeyPreimage, readyValue] at built
  | true =>
      exact key_preimage_ready_implies_semantic_inputs_resolved
        input.context
        readyValue

theorem built_preimage_implies_unique_semantic_dependencies
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    semanticDependenciesUnique input.context = true := by
  cases readyValue : keyPreimageReady input.context with
  | false =>
      simp [buildObligationKeyPreimage, readyValue] at built
  | true =>
      exact key_preimage_ready_implies_unique_semantic_dependencies
        input.context
        readyValue

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
