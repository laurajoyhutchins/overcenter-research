import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.Proofs
import Overcenter.ExecutionProofs
import Overcenter.ClaimProofs

open Lean

namespace Overcenter.Protocol

private def field (json : Json) (name : String) : Except String Json :=
  json.getObjVal? name

private def stringField (json : Json) (name : String) : Except String String := do
  (← field json name).getStr?

private def boolField (json : Json) (name : String) : Except String Bool := do
  (← field json name).getBool?

private def natField (json : Json) (name : String) : Except String Nat := do
  (← field json name).getNat?

private def optionalStringField (json : Json) (name : String) : Except String (Option String) := do
  let value ← field json name
  if value.isNull then
    pure none
  else
    pure (some (← value.getStr?))

private def parseFamily : String → Except String VerifierFamily
  | "immutable-artifact" => pure .immutableArtifact
  | "file-content" => pure .fileContent
  | "eventually-consistent-file-content" => pure .eventuallyConsistentFileContent
  | "github-commit-status" => pure .githubCommitStatus
  | "kubernetes-configmap-exists" => pure .kubernetesConfigMapExists
  | other => throw s!"unsupported verifier family: {other}"

private def parseCertainty : String → Except String MutationCertainty
  | "present" => pure .present
  | "absent" => pure .absent
  | "uncertain" => pure .uncertain
  | other => throw s!"unsupported mutation certainty: {other}"

private def parseCoordinate (family : VerifierFamily) (json : Json) : Except String Coordinate := do
  match family with
  | .githubCommitStatus =>
      pure (.githubCommitStatus
        (← natField json "repository_id")
        (← stringField json "commit_sha")
        (← stringField json "context"))
  | .kubernetesConfigMapExists =>
      pure (.kubernetesConfigMap
        (← stringField json "authority_id")
        (← stringField json "namespace")
        (← stringField json "name"))
  | _ =>
      pure (.opaque (← json.getStr?))

private def parsePostcondition (json : Json) : Except String Postcondition := do
  let family ← parseFamily (← stringField json "family")
  pure {
    family
    verifierRevision := ← stringField json "verifier_revision"
    coordinate := ← parseCoordinate family (← field json "coordinate")
    expected := ← stringField json "expected"
  }

private def parseKubernetesMember (json : Json) : Except String KubernetesListMember := do
  pure {
    name := ← stringField json "name"
    namespaceName := ← stringField json "namespace"
    uid := ← stringField json "uid"
    resourceVersion := ← stringField json "resource_version"
  }

private def parseKubernetesPage (json : Json) : Except String KubernetesListPage := do
  let membersJson ← (← field json "members").getArr?
  let members ← membersJson.toList.mapM parseKubernetesMember
  pure {
    authorityId := ← stringField json "authority_id"
    requestNamespace := ← stringField json "request_namespace"
    requestContinue := ← optionalStringField json "request_continue"
    responseContinue := ← stringField json "response_continue"
    snapshotResourceVersion := ← stringField json "snapshot_resource_version"
    members
  }

private def parseKubernetesPages (json : Json) : Except String (List KubernetesListPage) := do
  let pages ← json.getArr?
  pages.toList.mapM parseKubernetesPage

private def parseWatchEventType : String → Except String KubernetesWatchEventType
  | "ADDED" => pure .added
  | "MODIFIED" => pure .modified
  | "DELETED" => pure .deleted
  | other => throw s!"unsupported Kubernetes watch event type: {other}"

private def parseWatchTermination : String → Except String KubernetesWatchTermination
  | "client-stop" => pure .clientStop
  | "eof" => pure .eof
  | "timeout" => pure .timeout
  | "gone" => pure .gone
  | "error" => pure .error
  | other => throw s!"unsupported Kubernetes watch termination: {other}"

private def parseKubernetesWatchEvent (json : Json) : Except String KubernetesWatchEvent := do
  pure {
    eventType := ← parseWatchEventType (← stringField json "type")
    member := ← parseKubernetesMember (← field json "member")
  }

private def parseKubernetesWatch (json : Json) : Except String KubernetesWatchTranscript := do
  let eventJson ← (← field json "events").getArr?
  let events ← eventJson.toList.mapM parseKubernetesWatchEvent
  pure {
    authorityId := ← stringField json "authority_id"
    requestNamespace := ← stringField json "request_namespace"
    startResourceVersion := ← stringField json "start_resource_version"
    termination := ← parseWatchTermination (← stringField json "termination")
    events
  }

private def parseAbsence (json : Json) : Except String (Option AbsenceEvidence) := do
  if json.isNull then
    return none
  let kind ← stringField json "kind"
  if kind = "local-file-enoent/v1" then
    return some (.localFileEnoent
      (← stringField json "subject_coordinate")
      (← stringField json "scope_coordinate")
      (← boolField json "snapshot_is_null")
      (← stringField json "completeness_kind")
      (← stringField json "completeness_result")
      (← stringField json "provenance_adapter")
      (← stringField json "provenance_operation")
      (← stringField json "provenance_error_code"))
  if kind = "kubernetes-complete-list-absence/v1" then
    return some (.kubernetesCompleteList
      (← stringField json "authority_id")
      (← stringField json "namespace")
      (← stringField json "name")
      (← stringField json "snapshot_resource_version")
      (← parseKubernetesPages (← field json "pages")))
  throw s!"unsupported absence evidence kind: {kind}"

private def parseObservation (json : Json) : Except String Observation := do
  let family ← parseFamily (← stringField json "family")
  pure {
    family
    verifierRevision := ← stringField json "verifier_revision"
    coordinate := ← parseCoordinate family (← field json "coordinate")
    certainty := ← parseCertainty (← stringField json "certainty")
    actual := ← optionalStringField json "actual"
    absence := ← parseAbsence (← field json "absence")
  }

private def parseExecutionStatus : String → Except String ExecutionStatus
  | "EXECUTING" => pure .executing
  | "WAITING" => pure .waiting
  | "RECOVERY_REQUIRED" => pure .recoveryRequired
  | "DONE" => pure .done
  | "READY" => pure .ready
  | other => throw s!"unsupported execution status: {other}"

private def executionStatusName : ExecutionStatus → String
  | .executing => "EXECUTING"
  | .waiting => "WAITING"
  | .recoveryRequired => "RECOVERY_REQUIRED"
  | .done => "DONE"
  | .ready => "READY"

private def parseObservationDisposition : String → Except String ObservationDisposition
  | "DONE" => pure .done
  | "READY" => pure .ready
  | "RECOVERY_REQUIRED" => pure .recoveryRequired
  | other => throw s!"unsupported observation disposition: {other}"

private def parseExecutionSeed (json : Json) : Except String ExecutionState := do
  pure {
    runId := ← stringField json "run_id"
    obligationId := ← stringField json "obligation_id"
    claimedRevision := ← stringField json "claimed_revision"
    claimCommit := ← stringField json "claim_commit"
    generation := ← natField json "generation"
    authorityCommit := ← stringField json "authority_commit"
    capabilityDigest := ← stringField json "capability_digest"
    status := ← parseExecutionStatus (← stringField json "status")
    unresolvedEffect := ← boolField json "unresolved_effect"
  }

private def parseExecutionFact (json : Json) : Except String ExecutionFact := do
  let kind ← stringField json "kind"
  if kind = "rotate-authority" then
    return .rotateAuthority
      (← stringField json "commit")
      (← stringField json "run_id")
      (← stringField json "obligation_id")
      (← natField json "generation")
      (← stringField json "previous_authority_commit")
      (← stringField json "capability_digest")
  if kind = "reserve-effect" then
    return .reserveEffect
      (← stringField json "commit")
      (← stringField json "run_id")
      (← stringField json "obligation_id")
      (← natField json "generation")
      (← stringField json "authority_commit")
  if kind = "receipt" then
    let receiptKind ← stringField json "receipt_kind"
    let parsedKind ←
      if receiptKind = "judgment-required" then
        pure ExecutionReceiptKind.judgmentRequired
      else if receiptKind = "execution-terminated" then
        pure ExecutionReceiptKind.executionTerminated
      else if receiptKind = "observation" then
        pure (.observation (← parseObservationDisposition (← stringField json "disposition")))
      else
        throw s!"unsupported execution receipt kind: {receiptKind}"
    return .receipt
      (← stringField json "commit")
      (← stringField json "run_id")
      (← stringField json "obligation_id")
      (← stringField json "claimed_revision")
      (← stringField json "claim_commit")
      (← natField json "generation")
      (← stringField json "authority_commit")
      parsedKind
  throw s!"unsupported execution fact kind: {kind}"

private def parseExecutionFacts (json : Json) : Except String (List ExecutionFact) := do
  let facts ← json.getArr?
  facts.toList.mapM parseExecutionFact


private def parseClaimSelector : String → Except String ClaimSemanticSelector
  | "verified-content" => pure .verifiedContent
  | "settlement-receipt" => pure .settlementReceipt
  | other => throw s!"unsupported claim semantic selector: {other}"

private def parseClaimDependency (json : Json) : Except String ClaimDependency := do
  let kind ← stringField json "kind"
  let upstream ← stringField json "upstream"
  if kind = "control" then
    return .control upstream
  if kind = "semantic" then
    return .semantic upstream (← parseClaimSelector (← stringField json "selector"))
  throw s!"unsupported claim dependency kind: {kind}"

private def parseClaimDependencies (json : Json) : Except String (List ClaimDependency) := do
  let dependencies ← json.getArr?
  dependencies.toList.mapM parseClaimDependency

private def parseClaimObligation (json : Json) : Except String ClaimObligation := do
  pure {
    id := ← stringField json "id"
    packetIdentity := ← stringField json "packet_identity"
    postcondition := ← parsePostcondition (← field json "postcondition")
    dependencies := ← parseClaimDependencies (← field json "dependencies")
  }

private def parseClaimObligations (json : Json) : Except String (List ClaimObligation) := do
  let obligations ← json.getArr?
  obligations.toList.mapM parseClaimObligation

private def parseClaimSemanticIdentity
    (selector : ClaimSemanticSelector)
    (json : Json) : Except String ClaimSemanticIdentity := do
  match selector with
  | .verifiedContent =>
      let family ← parseFamily (← stringField json "family")
      pure (.verifiedContent
        family
        (← parseCoordinate family (← field json "coordinate"))
        (← stringField json "expected"))
  | .settlementReceipt =>
      pure (.settlementReceipt (← stringField json "commit"))

private def parseClaimSemanticInput (json : Json) : Except String ClaimSemanticInput := do
  let selector ← parseClaimSelector (← stringField json "selector")
  pure {
    selector
    identity := ← parseClaimSemanticIdentity selector (← field json "identity")
  }

private def parseClaimSemanticInputs (json : Json) : Except String (List ClaimSemanticInput) := do
  let inputs ← json.getArr?
  inputs.toList.mapM parseClaimSemanticInput

private def parseClaimKey (json : Json) : Except String ClaimObligationKey := do
  pure {
    id := ← stringField json "id"
    packetIdentity := ← stringField json "packet_identity"
    postcondition := ← parsePostcondition (← field json "postcondition")
    semanticInputs := ← parseClaimSemanticInputs (← field json "semantic_inputs")
  }

private def parseHistoricalClaimDisposition : String → Except String HistoricalClaimDisposition
  | "EXECUTING" => pure .executing
  | "WAITING" => pure .waiting
  | "RECOVERY_REQUIRED" => pure .recoveryRequired
  | "DONE" => pure .done
  | "READY" => pure .ready
  | other => throw s!"unsupported historical claim disposition: {other}"

private def parseHistoricalClaimRun (json : Json) : Except String HistoricalClaimRun := do
  pure {
    runId := ← stringField json "run_id"
    obligationId := ← stringField json "obligation_id"
    key := ← parseClaimKey (← field json "key")
    disposition := ← parseHistoricalClaimDisposition (← stringField json "disposition")
    settlementCommit := ← optionalStringField json "settlement_commit"
  }

private def parseHistoricalClaimRuns (json : Json) : Except String (List HistoricalClaimRun) := do
  let runs ← json.getArr?
  runs.toList.mapM parseHistoricalClaimRun


private def parseFreshClaimObservation (json : Json) : Except String FreshClaimObservation := do
  pure {
    obligationId := ← stringField json "obligation_id"
    observation := ← parseObservation (← field json "observation")
  }

private def parseFreshClaimObservations
    (json : Json) : Except String (List FreshClaimObservation) := do
  let observations ← json.getArr?
  observations.toList.mapM parseFreshClaimObservation

private def parseClaimCandidate (json : Json) : Except String ClaimCandidate := do
  pure {
    runId := ← stringField json "run_id"
    obligationId := ← stringField json "obligation_id"
    parentRevision := ← stringField json "parent_revision"
    claimedRevision := ← stringField json "claimed_revision"
    obligationKey := ← parseClaimKey (← field json "obligation_key")
    capabilityDigest := ← stringField json "capability_digest"
  }

private def claimAdmissionReasonName : ClaimAdmissionError → String
  | .invalidGraph => "INVALID_GRAPH"
  | .unorderedEffectConflict => "UNORDERED_EFFECT_CONFLICT"
  | .unknownObligation => "UNKNOWN_OBLIGATION"
  | .duplicateRun => "DUPLICATE_RUN"
  | .revisionMismatch => "REVISION_MISMATCH"
  | .claimWhileNotReady => "CLAIM_WHILE_NOT_READY"
  | .unsatisfiedDependencies => "UNSATISFIED_DEPENDENCIES"
  | .unresolvedSemanticDependency => "UNRESOLVED_SEMANTIC_DEPENDENCY"
  | .obligationKeyMismatch => "OBLIGATION_KEY_MISMATCH"
  | .invalidCapabilityDigest => "INVALID_CAPABILITY_DIGEST"

private def handleClaimEffectOrdering (request : Json) : Except String Json := do
  let obligations ← parseClaimObligations (← field request "obligations")
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-kernel/v1"),
    ("valid", claimStaticEffectOrderingValid obligations)
  ]

private def handleClaimGraph (request : Json) : Except String Json := do
  let obligations ← parseClaimObligations (← field request "obligations")
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-kernel/v1"),
    ("valid", claimGraphValid obligations)
  ]

private def handleClaimAdmission (request : Json) : Except String Json := do
  let currentRevision ← stringField request "current_revision"
  let obligations ← parseClaimObligations (← field request "obligations")
  let runs ← parseHistoricalClaimRuns (← field request "runs")
  let freshObservations ← parseFreshClaimObservations (← field request "fresh_observations")
  let candidate ← parseClaimCandidate (← field request "candidate")
  match admitClaim currentRevision obligations runs freshObservations candidate with
  | .accepted =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("accepted", true),
        ("reason", Json.null)
      ]
  | .rejected reason =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("accepted", false),
        ("reason", claimAdmissionReasonName reason)
      ]

private def dispositionName : Disposition → String
  | .done => "DONE"
  | .ready => "READY"
  | .recoveryRequired => "RECOVERY_REQUIRED"

private def kubernetesStateName : KubernetesListState → String
  | .present => "PRESENT"
  | .absent => "ABSENT"
  | .indeterminate => "INDETERMINATE"

private def kubernetesDisposition : KubernetesListState → Disposition
  | .present => .done
  | .absent => .ready
  | .indeterminate => .recoveryRequired

private def handleExecutionReplay (request : Json) : Except String Json := do
  let seed ← parseExecutionSeed (← field request "seed")
  let facts ← parseExecutionFacts (← field request "facts")
  match replayExecutionFacts seed facts with
  | none =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("accepted", false)
      ]
  | some state =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("accepted", true),
        ("generation", toString state.generation),
        ("authority_commit", state.authorityCommit),
        ("status", executionStatusName state.status),
        ("unresolved_effect", state.unresolvedEffect)
      ]

private def handleSettlement (request : Json) : Except String Json := do
  let postcondition ← parsePostcondition (← field request "postcondition")
  let observation ← parseObservation (← field request "observation")
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-kernel/v1"),
    ("disposition", dispositionName (settle postcondition observation))
  ]

private def handleKubernetesList (request : Json) : Except String Json := do
  let coordinate ← parseCoordinate .kubernetesConfigMapExists (← field request "coordinate")
  let snapshotResourceVersion ← stringField request "snapshot_resource_version"
  let pages ← parseKubernetesPages (← field request "pages")
  let state := classifyKubernetesList coordinate snapshotResourceVersion pages
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-kernel/v1"),
    ("state", kubernetesStateName state),
    ("disposition", dispositionName (kubernetesDisposition state))
  ]

private def handleKubernetesWatchCarry (request : Json) : Except String Json := do
  let coordinate ← parseCoordinate .kubernetesConfigMapExists (← field request "coordinate")
  let snapshotResourceVersion ← stringField request "snapshot_resource_version"
  let pages ← parseKubernetesPages (← field request "pages")
  let watch ← parseKubernetesWatch (← field request "watch")
  let carried := carryKubernetesAbsenceThroughWatchRaw
    coordinate
    snapshotResourceVersion
    pages
    watch
  match carried with
  | some resourceVersion =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("state", "CARRIED"),
        ("snapshot_resource_version", resourceVersion)
      ]
  | none =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-kernel/v1"),
        ("state", "RELIST_REQUIRED"),
        ("snapshot_resource_version", Json.null)
      ]

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command = "claim-effect-ordering" then
    handleClaimEffectOrdering request
  else if command = "claim-graph" then
    handleClaimGraph request
  else if command = "claim-admission" then
    handleClaimAdmission request
  else if command = "execution-replay" then
    handleExecutionReplay request
  else if command = "settle" then
    handleSettlement request
  else if command = "kubernetes-list" then
    handleKubernetesList request
  else if command = "kubernetes-watch-carry" then
    handleKubernetesWatchCarry request
  else
    throw s!"unsupported command: {command}"

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.Protocol
