import Overcenter.Admission

namespace Overcenter

theorem claim_admitted_implies_context_well_formed
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    claimContextWellFormed ctx = true := by
  simp [claimAdmissible] at admitted
  exact admitted.1.1.1.1.1

theorem claim_admitted_implies_exact_revision
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    ctx.expectedRevision = ctx.currentRevision := by
  simp [claimAdmissible] at admitted
  exact admitted.1.1.1.1.2

theorem claim_admitted_implies_target_unrealized
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    (findClaimLifecycle ctx.lifecycles ctx.targetId == some .unrealized) = true := by
  simp [claimAdmissible] at admitted
  exact admitted.1.1.1.2

theorem claim_admitted_implies_dependencies_done
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    claimDependenciesDone ctx = true := by
  simp [claimAdmissible] at admitted
  exact admitted.1.1.2

theorem claim_admitted_implies_semantic_inputs_resolved
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    claimSemanticInputsResolved ctx = true := by
  simp [claimAdmissible] at admitted
  exact admitted.1.2

theorem claim_admitted_implies_no_unordered_effect_conflict
    (ctx : ClaimContext)
    (admitted : claimAdmissible ctx = true) :
    claimUnorderedEffectConflict ctx = false := by
  simp [claimAdmissible] at admitted
  exact admitted.2

private def noEffect : Option ClaimEffect := none

private def leaf : ClaimObligation := {
  id := "leaf"
  dependencies := []
  effect := noEffect
}

private def leafContext : ClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "leaf"
  obligations := [leaf]
  lifecycles := [{ obligationId := "leaf", status := .unrealized }]
}

example : claimAdmissible leafContext = true := by native_decide
example : claimAdmissible { leafContext with expectedRevision := "stale" } = false := by native_decide
example :
    claimAdmissible {
      leafContext with
      lifecycles := [{ obligationId := "leaf", status := .executing }]
    } = false := by native_decide

private def upstream : ClaimObligation := {
  id := "upstream"
  dependencies := []
}

private def semanticTarget : ClaimObligation := {
  id := "target"
  dependencies := [{
    upstream := "upstream"
    kind := .semantic
    semanticIdentity := some "settlement:abc"
  }]
}

private def semanticContext : ClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "target"
  obligations := [upstream, semanticTarget]
  lifecycles := [
    { obligationId := "upstream", status := .done },
    { obligationId := "target", status := .unrealized }
  ]
}

example : claimAdmissible semanticContext = true := by native_decide
example :
    claimAdmissible {
      semanticContext with
      obligations := [
        upstream,
        {
          semanticTarget with
          dependencies := [{
            upstream := "upstream"
            kind := .semantic
            semanticIdentity := none
          }]
        }
      ]
    } = false := by native_decide

private def statusSuccess : ClaimEffect := {
  resource := "github-status:1:sha:ctx"
  desired := "success"
  sameDesiredCommutes := true
}

private def statusFailure : ClaimEffect := {
  statusSuccess with
  desired := "failure"
}

private def alpha : ClaimObligation := {
  id := "alpha"
  dependencies := []
  effect := some statusSuccess
}

private def betaConflict : ClaimObligation := {
  id := "beta"
  dependencies := []
  effect := some statusFailure
}

private def conflictContext : ClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "beta"
  obligations := [alpha, betaConflict]
  lifecycles := [
    { obligationId := "alpha", status := .done },
    { obligationId := "beta", status := .unrealized }
  ]
}

example : claimAdmissible conflictContext = false := by native_decide

private def betaOrdered : ClaimObligation := {
  betaConflict with
  dependencies := [{
    upstream := "alpha"
    kind := .control
  }]
}

example :
    claimAdmissible {
      conflictContext with
      obligations := [alpha, betaOrdered]
    } = true := by native_decide

end Overcenter
