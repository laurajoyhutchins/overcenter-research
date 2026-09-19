import Overcenter.SemanticIdentity

namespace Overcenter

theorem derived_claim_admitted_implies_semantic_inputs_resolved
    (ctx : RawClaimContext)
    (admitted : derivedClaimAdmissible ctx = true) :
    rawSemanticInputsResolved ctx = true := by
  simp [derivedClaimAdmissible] at admitted
  exact admitted.2.1

theorem derived_claim_admitted_implies_base_claim_admissible
    (ctx : RawClaimContext)
    (admitted : derivedClaimAdmissible ctx = true) :
    claimAdmissible (rawToBaseClaimContext ctx) = true := by
  simp [derivedClaimAdmissible] at admitted
  exact admitted.2.2

private def outputSource : NormalizedSemanticSource :=
  .fileContent "aaaaaaaa"

private def outputMaterial : SemanticOutputMaterial :=
  semanticOutputMaterialFor outputSource

private def upstream : RawClaimObligation := {
  id := "upstream"
  dependencies := []
  semanticSource := some outputSource
}

private def outputDependency : RawClaimDependency := {
  upstream := "upstream"
  kind := .semantic
  selector := some .verifiedContent
}

private def evidenceDependency : RawClaimDependency := {
  upstream := "upstream"
  kind := .semantic
  selector := some .settlementReceipt
}

private def targetWith (dependency : RawClaimDependency) : RawClaimObligation := {
  id := "target"
  dependencies := [dependency]
}

private def outputContext : RawClaimContext := {
  currentRevision := "r1"
  expectedRevision := "r1"
  targetId := "target"
  obligations := [upstream, targetWith outputDependency]
  lifecycles := [
    { obligationId := "upstream", status := .done, runId := some "run-current" },
    { obligationId := "target", status := .unrealized, runId := none }
  ]
  receipts := []
}

example :
    deriveSemanticIdentityMaterial outputContext outputDependency =
      some (.output outputMaterial) := by decide

example :
    deriveSemanticIdentityMaterial
      {
        outputContext with
        lifecycles := [
          { obligationId := "upstream", status := .executing, runId := some "run-current" },
          { obligationId := "target", status := .unrealized, runId := none }
        ]
      }
      outputDependency = none := by decide

private def evidenceContext : RawClaimContext := {
  outputContext with
  obligations := [upstream, targetWith evidenceDependency]
  receipts := [{
    runId := "run-current"
    obligationId := "upstream"
    disposition := .done
    settlementCommit := some "settlement-current"
  }]
}

example :
    deriveSemanticIdentityMaterial evidenceContext evidenceDependency =
      some (.settlementReceipt "settlement-current") := by decide

-- A receipt from a stale historical run cannot satisfy the current DONE realization.
example :
    deriveSemanticIdentityMaterial
      {
        evidenceContext with
        receipts := [{
          runId := "run-old"
          obligationId := "upstream"
          disposition := .done
          settlementCommit := some "settlement-old"
        }]
      }
      evidenceDependency = none := by decide

-- A receipt for a different obligation cannot be borrowed.
example :
    deriveSemanticIdentityMaterial
      {
        evidenceContext with
        receipts := [{
          runId := "run-current"
          obligationId := "other"
          disposition := .done
          settlementCommit := some "settlement-other"
        }]
      }
      evidenceDependency = none := by decide

-- Non-DONE evidence and missing settlement identity fail closed.
example :
    deriveSemanticIdentityMaterial
      {
        evidenceContext with
        receipts := [{
          runId := "run-current"
          obligationId := "upstream"
          disposition := .ready
          settlementCommit := some "settlement-current"
        }]
      }
      evidenceDependency = none := by decide

example :
    deriveSemanticIdentityMaterial
      {
        evidenceContext with
        receipts := [{
          runId := "run-current"
          obligationId := "upstream"
          disposition := .done
          settlementCommit := none
        }]
      }
      evidenceDependency = none := by decide

example : derivedClaimAdmissible outputContext = true := by decide
example : derivedClaimAdmissible evidenceContext = true := by decide

end Overcenter
