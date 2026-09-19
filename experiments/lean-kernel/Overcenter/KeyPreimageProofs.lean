import Overcenter.KeyPreimage

namespace Overcenter

theorem key_preimage_ready_implies_semantic_inputs_resolved
    (ctx : RawClaimContext)
    (ready : keyPreimageReady ctx = true) :
    rawSemanticInputsResolved ctx = true := by
  have outer := Bool.and_eq_true.mp ready
  have inner := Bool.and_eq_true.mp outer.1
  exact inner.2

theorem key_preimage_ready_implies_unique_semantic_dependencies
    (ctx : RawClaimContext)
    (ready : keyPreimageReady ctx = true) :
    semanticDependenciesUnique ctx = true := by
  exact (Bool.and_eq_true.mp ready).2

theorem planned_hashes_imply_key_preimage_ready
    (ctx : RawClaimContext)
    (planned : List String)
    (result : plannedIdentityHashBytes ctx = some planned) :
    keyPreimageReady ctx = true := by
  by_contra notReady
  have readyFalse : keyPreimageReady ctx = false :=
    Bool.eq_false_of_not_eq_true notReady
  simp [plannedIdentityHashBytes, readyFalse] at result

theorem built_preimage_implies_semantic_inputs_resolved
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    rawSemanticInputsResolved input.context = true := by
  unfold buildObligationKeyPreimage at built
  split at built
  · contradiction
  · rename_i planned
    split at built
    · contradiction
    · have plannedResult : plannedIdentityHashBytes input.context = some planned := by
        assumption
      exact key_preimage_ready_implies_semantic_inputs_resolved
        input.context
        (planned_hashes_imply_key_preimage_ready input.context planned plannedResult)

theorem built_preimage_implies_unique_semantic_dependencies
    (input : ObligationKeyInput)
    (results : List KeyHashResult)
    (bytes : String)
    (built : buildObligationKeyPreimage input results = some bytes) :
    semanticDependenciesUnique input.context = true := by
  unfold buildObligationKeyPreimage at built
  split at built
  · contradiction
  · rename_i planned
    split at built
    · contradiction
    · have plannedResult : plannedIdentityHashBytes input.context = some planned := by
        assumption
      exact key_preimage_ready_implies_unique_semantic_dependencies
        input.context
        (planned_hashes_imply_key_preimage_ready input.context planned plannedResult)

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

private def leafInput : ObligationKeyInput := {
  context := leafContext
  packet := Json.mkObj [
    ("nested", Json.mkObj [("z", 1), ("a", 2)]),
    ("flag", true)
  ]
  postcondition := Json.mkObj [
    ("verifier", "file-content-equals/v1"),
    ("path", "/provider/leaf"),
    ("content", "A")
  ]
}

example : plannedIdentityHashBytes leafContext = some [] := by decide

example :
    buildObligationKeyPreimage leafInput [] =
      some "{\"id\":\"leaf\",\"packet\":{\"flag\":true,\"nested\":{\"a\":2,\"z\":1}},\"postcondition\":{\"content\":\"A\",\"path\":\"/provider/leaf\",\"verifier\":\"file-content-equals/v1\"},\"semantic_dependencies\":[]}" := by
  decide

end Overcenter
