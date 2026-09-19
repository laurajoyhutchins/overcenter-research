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

private def upstreamFresh : FreshClaimObservation := {
  obligationId := "upstream"
  observation := {
    family := .fileContent
    verifierRevision := "file-content-equals/v1@semantics-1"
    coordinate := .opaque "/provider/upstream"
    certainty := .present
    actual := some "sha256:upstream"
  }
}

private def upstreamWrongFresh : FreshClaimObservation := {
  upstreamFresh with
  observation := {
    upstreamFresh.observation with
    actual := some "sha256:drifted"
  }
}

private def keyFor
    (obligation : ClaimObligation)
    (runs : List HistoricalClaimRun)
    (fresh : List FreshClaimObservation) :
    ClaimObligationKey :=
  (deriveClaimObligationKey graph runs fresh obligation (graph.length + 1)).getD {
    id := "unresolved"
    packetIdentity := ""
    postcondition := obligation.postcondition
    semanticInputs := []
  }

private def candidateFor
    (obligation : ClaimObligation)
    (runs : List HistoricalClaimRun)
    (fresh : List FreshClaimObservation) : ClaimCandidate := {
  runId := s!"run-{obligation.id}"
  obligationId := obligation.id
  parentRevision := "revision-a"
  claimedRevision := "revision-a"
  obligationKey := keyFor obligation runs fresh
  capabilityDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

-- Mutable historical DONE is not current truth without a fresh verifying observation.
example :
    deriveClaimLifecycle graph [upstreamDone] [] "upstream" (graph.length + 1) =
      some .unrealized := by native_decide

example :
    deriveClaimLifecycle graph [upstreamDone] [upstreamFresh] "upstream" (graph.length + 1) =
      some .done := by native_decide

example :
    deriveClaimLifecycle graph [upstreamDone] [upstreamWrongFresh] "upstream" (graph.length + 1) =
      some .unrealized := by native_decide

-- Multiple competing fresh observations fail closed instead of choosing one.
example :
    deriveClaimLifecycle
      graph
      [upstreamDone]
      [upstreamFresh, upstreamFresh]
      "upstream"
      (graph.length + 1) = some .unrealized := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      (candidateFor downstreamControl [upstreamDone] [upstreamFresh]) =
        .accepted := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamReady]
      []
      (candidateFor downstreamControl [upstreamReady] []) =
        .rejected .unsatisfiedDependencies := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      { candidateFor downstreamControl [upstreamDone] [upstreamFresh] with
        claimedRevision := "stale-revision" } =
        .rejected .revisionMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      { candidateFor downstreamControl [upstreamDone] [upstreamFresh] with
        parentRevision := "stale-parent" } =
        .rejected .revisionMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      { candidateFor downstreamControl [upstreamDone] [upstreamFresh] with
        obligationKey := upstreamKey } =
        .rejected .obligationKeyMismatch := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      { candidateFor downstreamControl [upstreamDone] [upstreamFresh] with
        capabilityDigest := "not-a-digest" } =
        .rejected .invalidCapabilityDigest := by native_decide

example :
    admitClaim
      "revision-a"
      graph
      [upstreamDone]
      [upstreamFresh]
      { candidateFor downstreamControl [upstreamDone] [upstreamFresh] with
        runId := "run-upstream" } =
        .rejected .duplicateRun := by native_decide

example :
    deriveClaimObligationKey
      graph
      [upstreamDone]
      [upstreamFresh]
      downstreamOutput
      (graph.length + 1) =
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
    deriveClaimObligationKey
      graph
      [upstreamDone]
      [upstreamFresh]
      downstreamReceipt
      (graph.length + 1) =
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
    deriveClaimObligationKey graph [upstreamReady] [] downstreamOutput (graph.length + 1) =
      none := by native_decide

-- Historical DONE without fresh verification also cannot supply semantic identity.
example :
    deriveClaimObligationKey graph [upstreamDone] [] downstreamOutput (graph.length + 1) =
      none := by native_decide

-- Changing verified upstream output changes downstream semantic meaning.
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

private def changedFresh : FreshClaimObservation := {
  obligationId := "upstream"
  observation := {
    family := .fileContent
    verifierRevision := "file-content-equals/v1@semantics-1"
    coordinate := .opaque "/provider/upstream"
    certainty := .present
    actual := some "sha256:changed"
  }
}

example :
    deriveClaimObligationKey
      changedGraph
      [changedUpstreamDone]
      [changedFresh]
      downstreamOutput
      (changedGraph.length + 1)
    != deriveClaimObligationKey
      graph
      [upstreamDone]
      [upstreamFresh]
      downstreamOutput
      (graph.length + 1) := by native_decide

-- Changing only the settlement receipt changes evidence-consuming downstream meaning.
private def newerSettlement : HistoricalClaimRun := {
  upstreamDone with
  runId := "run-upstream-new"
  settlementCommit := some "settlement-upstream-new"
}

example :
    deriveClaimObligationKey
      graph
      [newerSettlement]
      [upstreamFresh]
      downstreamReceipt
      (graph.length + 1)
    != deriveClaimObligationKey
      graph
      [upstreamDone]
      [upstreamFresh]
      downstreamReceipt
      (graph.length + 1) := by native_decide

-- Claim admission owns enough graph topology to fail closed on malformed input.
example : claimGraphValid graph = true := by native_decide

private def duplicateGraph : List ClaimObligation :=
  [upstream, { upstream with packetIdentity := "duplicate" }]

example : claimGraphValid duplicateGraph = false := by native_decide

private def danglingGraph : List ClaimObligation := [
  {
    downstreamControl with
    dependencies := [.control "missing"]
  }
]

example : claimGraphValid danglingGraph = false := by native_decide

private def cycleA : ClaimObligation := {
  id := "cycle-a"
  packetIdentity := "cycle-a"
  postcondition := claimPostcondition "/provider/cycle-a" "sha256:a"
  dependencies := [.control "cycle-b"]
}

private def cycleB : ClaimObligation := {
  id := "cycle-b"
  packetIdentity := "cycle-b"
  postcondition := claimPostcondition "/provider/cycle-b" "sha256:b"
  dependencies := [.semantic "cycle-a" .verifiedContent]
}

private def cyclicGraph : List ClaimObligation := [cycleA, cycleB]

example : claimGraphValid cyclicGraph = false := by native_decide

example :
    admitClaim
      "revision-a"
      duplicateGraph
      []
      []
      (candidateFor upstream [] []) =
        .rejected .invalidGraph := by native_decide

private def githubStatusPostcondition
    (context expected : String) : Postcondition := {
  family := .githubCommitStatus
  verifierRevision := "github-commit-status/v2@semantics-1"
  coordinate := .githubCommitStatus 123 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" context
  expected
}

private def statusSuccess : ClaimObligation := {
  id := "status-success"
  packetIdentity := "packet-status-success"
  postcondition := githubStatusPostcondition "Overcenter/Proof" "success"
  dependencies := []
}

private def statusFailure : ClaimObligation := {
  id := "status-failure"
  packetIdentity := "packet-status-failure"
  postcondition := githubStatusPostcondition "overcenter/proof" "failure"
  dependencies := []
}

private def statusSuccessAgain : ClaimObligation := {
  id := "status-success-again"
  packetIdentity := "packet-status-success-again"
  postcondition := githubStatusPostcondition "OVERCENTER/PROOF" "success"
  dependencies := []
}

private def statusOtherContext : ClaimObligation := {
  id := "status-other"
  packetIdentity := "packet-status-other"
  postcondition := githubStatusPostcondition "overcenter/other" "failure"
  dependencies := []
}

private def unorderedStatusConflict : List ClaimObligation :=
  [statusSuccess, statusFailure]

private def commutingStatusWrites : List ClaimObligation :=
  [statusSuccess, statusSuccessAgain]

private def independentStatusCoordinates : List ClaimObligation :=
  [statusSuccess, statusOtherContext]

private def orderedStatusFailure : ClaimObligation := {
  statusFailure with
  dependencies := [.control "status-success"]
}

private def orderedStatusConflict : List ClaimObligation :=
  [statusSuccess, orderedStatusFailure]

example : claimGraphValid unorderedStatusConflict = true := by native_decide
example : claimStaticEffectOrderingValid unorderedStatusConflict = false := by native_decide

-- GitHub status context identity is case-insensitive.
example :
    (claimEffectSemantics statusSuccess.postcondition).map (fun effect => effect.resource) =
    (claimEffectSemantics statusFailure.postcondition).map (fun effect => effect.resource) := by
  native_decide

-- Identical writes to the same coordinate commute.
example : claimStaticEffectOrderingValid commutingStatusWrites = true := by native_decide

-- Different contexts are different provider resources.
example : claimStaticEffectOrderingValid independentStatusCoordinates = true := by native_decide

-- Incompatible writes are legal only when the graph orders them.
example : claimStaticEffectOrderingValid orderedStatusConflict = true := by native_decide

example :
    admitClaim
      "revision-a"
      unorderedStatusConflict
      []
      []
      {
        runId := "run-status-success"
        obligationId := "status-success"
        parentRevision := "revision-a"
        claimedRevision := "revision-a"
        obligationKey := {
          id := "status-success"
          packetIdentity := "packet-status-success"
          postcondition := statusSuccess.postcondition
          semanticInputs := []
        }
        capabilityDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      } =
        .rejected .unorderedEffectConflict := by native_decide

end Overcenter
