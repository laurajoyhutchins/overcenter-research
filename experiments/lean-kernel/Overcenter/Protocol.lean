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

private def parsePostcondition (json : Json) : Except String Postcondition := do
  pure {
    family := ← parseFamily (← stringField json "family")
    verifierRevision := ← stringField json "verifier_revision"
    coordinate := ← stringField json "coordinate"
    expected := ← stringField json "expected"
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
      (← stringField json "coordinate")
      (← boolField json "complete"))
  throw s!"unsupported absence evidence kind: {kind}"

private def parseObservation (json : Json) : Except String Observation := do
  pure {
    family := ← parseFamily (← stringField json "family")
    verifierRevision := ← stringField json "verifier_revision"
    coordinate := ← stringField json "coordinate"
    certainty := ← parseCertainty (← stringField json "certainty")
    actual := ← optionalStringField json "actual"
    absence := ← parseAbsence (← field json "absence")
  }

private def dispositionName : Disposition → String
  | .done => "DONE"
  | .ready => "READY"
  | .recoveryRequired => "RECOVERY_REQUIRED"

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command != "settle" then
    throw s!"unsupported command: {command}"
  let postcondition ← parsePostcondition (← field request "postcondition")
  let observation ← parseObservation (← field request "observation")
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-kernel/v1"),
    ("disposition", dispositionName (settle postcondition observation))
  ]

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.Protocol
