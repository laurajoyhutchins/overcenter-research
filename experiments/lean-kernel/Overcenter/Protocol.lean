import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.Proofs

open Lean

namespace Overcenter.Protocol

private def field (json : Json) (name : String) : Except String Json :=
  json.getObjVal? name

private def stringField (json : Json) (name : String) : Except String String := do
  (← field json name).getStr?

private def boolField (json : Json) (name : String) : Except String Bool := do
  (← field json name).getBool?

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
  if command = "settle" then
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
