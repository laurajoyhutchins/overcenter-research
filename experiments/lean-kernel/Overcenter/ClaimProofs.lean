import Std.Tactic
import Overcenter.Claim

namespace Overcenter

private def claimPostcondition (path expected : String) : Postcondition := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque path
  expected
}

private def upstream : ClaimObligation := {
  id := "upstream"
  packetIdentity := "packet-upstream"
  postcondition := claimPostcondition "/provider/upstream" "sha256:upstream"
  dependencies := []
}

private def downstreamControl : ClaimObligation := {
  id := "downstream-control"
  packetIdentity := "packet-control"
  postcondition := claimPostcondition "/provider/control" "sha256:control"
  dependencies := [.control "upstream"]
}

private def downstreamOutput : ClaimObligation := {
  id := "downstream-output"
  packetIdentity := "packet-output"
  postcondition := claimPostcondition "/provider/output" "sha256:output"
  dependencies := [.semantic "upstream" .verifiedContent]
}

private def downstreamReceipt : ClaimObligation := {
  id := "downstream-receipt"
  packetIdentity := "packet-receipt"
  postcondition := claimPostcondition "/provider/receipt" "sha256:receipt"
  dependencies := [.semantic "upstream" .settlementReceipt]
}

private def graph : List ClaimObligation :=
  [upstream, downstreamControl, downstreamOutput, downstreamReceipt]

private def upstreamKey : ClaimObligationKey := {
  id := "upstream"
  packetIdentity := "packet-upstream"
  postcondition := upstream.postcondition
  semanticInputs := []
}

private def upstreamDone : HistoricalClaimRun := {
  runId := "run-upstream"
  obligationId := "upstream"
  key := upstreamKey
  disposition := .done
  settlementCommit := some "settlement-upstream"
}

private def upstreamReady : HistoricalClaimRun := {
  upstreamDone with
  disposition := .ready
  settlementCommit := none
}

private def keyFor (obligation : ClaimObligation) (runs : List HistoricalClaimRun) :
    ClaimObligationKey :=
  (deriveClaimObligationKey graph runs obligation (graph.length + 1)).getD {
    id := "unresolved"
    packetIdentity := ""
    postcondition := obligation.postcondition
    semanticInputs := []
  }

private def candidateFor
    (obligation : ClaimObligation)
    (runs : List HistoricalClaimRun) : ClaimCandidate := {
  runId := s!"run-{obligation.id}"
  obligationId := obligation.id
  parentRevision := "revision-a"
  claimedRevision := "revision-a"
  obligationKey := keyFor obligation runs
  capabilityDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      (candidateFor downstreamControl [upstreamDone]) = .accepted := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamReady]
      (candidateFor downstreamControl [upstreamReady]) =
        .rejected .unsatisfiedDependencies := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      { candidateFor downstreamControl [upstreamDone] with
        claimedRevision := "stale-revision" } =
        .rejected .revisionMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      { candidateFor downstreamControl [upstreamDone] with
        parentRevision := "stale-parent" } =
        .rejected .revisionMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      { candidateFor downstreamControl [upstreamDone] with
        obligationKey := upstreamKey } =
        .rejected .obligationKeyMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      { candidateFor downstreamControl [upstreamDone] with
        capabilityDigest := "not-a-digest" } =
        .rejected .invalidCapabilityDigest := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      { candidateFor downstreamControl [upstreamDone] with
        runId := "run-upstream" } =
        .rejected .duplicateRun := by native_decide

example :
    deriveClaimObligationKey graph [upstreamDone] downstreamOutput (graph.length + 1) =
      some {
        id := "downstream-output"
        packetIdentity := "packet-output"
        postcondition := downstreamOutput.postcondition
        semanticInputs := [{
          selector := .verifiedContent
          identity := .verifiedContent
            .fileContent
            (.opaque "/provider/upstream")
            "sha256:upstream"
        }]
      } := by native_decide

example :
    deriveClaimObligationKey graph [upstreamDone] downstreamReceipt (graph.length + 1) =
      some {
        id := "downstream-receipt"
        packetIdentity := "packet-receipt"
        postcondition := downstreamReceipt.postcondition
        semanticInputs := [{
          selector := .settlementReceipt
          identity := .settlementReceipt "settlement-upstream"
        }]
      } := by native_decide

-- A READY settlement is not a realized dependency and cannot supply semantic identity.
example :
    deriveClaimObligationKey graph [upstreamReady] downstreamOutput (graph.length + 1) =
      none := by native_decide

-- Changing verified upstream output changes the downstream semantic key.
private def changedUpstream : ClaimObligation := {
  upstream with
  postcondition := claimPostcondition "/provider/upstream" "sha256:changed"
}

private def changedGraph : List ClaimObligation :=
  [changedUpstream, downstreamControl, downstreamOutput, downstreamReceipt]

private def changedUpstreamKey : ClaimObligationKey := {
  upstreamKey with
  postcondition := changedUpstream.postcondition
}

private def changedUpstreamDone : HistoricalClaimRun := {
  upstreamDone with
  key := changedUpstreamKey
}

example :
    deriveClaimObligationKey changedGraph [changedUpstreamDone] downstreamOutput (changedGraph.length + 1)
    != deriveClaimObligationKey graph [upstreamDone] downstreamOutput (graph.length + 1) := by native_decide

-- Changing only the settlement receipt changes evidence-consuming downstream meaning.
private def newerSettlement : HistoricalClaimRun := {
  upstreamDone with
  runId := "run-upstream-new"
  settlementCommit := some "settlement-upstream-new"
}

example :
    deriveClaimObligationKey graph [newerSettlement] downstreamReceipt (graph.length + 1)
    != deriveClaimObligationKey graph [upstreamDone] downstreamReceipt (graph.length + 1) := by native_decide

end Overcenter
