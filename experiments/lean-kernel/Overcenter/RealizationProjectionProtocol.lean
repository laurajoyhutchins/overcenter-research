import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.Protocol
import Overcenter.RealizationProjectionProofs

open Lean

namespace Overcenter.RealizationProjectionProtocol

private def field (json : Json) (name : String) : Except String Json :=
  json.getObjVal? name

private def stringField (json : Json) (name : String) : Except String String := do
  (← field json name).getStr?

private def optionalStringField (json : Json) (name : String) : Except String (Option String) := do
  let value ← field json name
  if value.isNull then pure none else pure (some (← value.getStr?))

private def rejectField (json : Json) (name : String) : Except String Unit := do
  match field json name with
  | .ok _ => throw s!"trusted {name} is forbidden"
  | .error _ => pure ()

private def rejectTrustedProjectionClaims (json : Json) : Except String Unit := do
  for name in [
    "reusable",
    "current",
    "fresh_verified",
    "fresh_authoritative_absence",
    "stability",
    "lifecycle",
    "safe_to_reexecute"
  ] do
    rejectField json name

private def parseRun (json : Json) : Except String RealizationRun := do
  pure {
    runId := ← stringField json "run_id"
    obligationKey := ← stringField json "obligation_key"
    status := ← Overcenter.Protocol.parseExecutionStatus (← stringField json "status")
  }

private def parseRuns (json : Json) : Except String (List RealizationRun) := do
  let values ← json.getArr?
  values.toList.mapM parseRun

private def parseFreshObservation (json : Json) : Except String (Option Observation) := do
  if json.isNull then pure none
  else pure (some (← Overcenter.Protocol.parseObservation json))

private def lifecycleName : RealizationLifecycle → String
  | .unrealized => "UNREALIZED"
  | .executing => "EXECUTING"
  | .waiting => "WAITING"
  | .recoveryRequired => "RECOVERY_REQUIRED"
  | .done => "DONE"

def handleJson (request : Json) : Except String Json := do
  rejectTrustedProjectionClaims request
  let command ← stringField request "command"
  if command != "realization-project" then
    throw s!"unsupported command: {command}"
  let input : RealizationProjectionInput := {
    postcondition := ← Overcenter.Protocol.parsePostcondition (← field request "postcondition")
    currentKey := ← optionalStringField request "current_key"
    runs := ← parseRuns (← field request "runs")
    freshObservation := ← parseFreshObservation (← field request "fresh_observation")
  }
  let projected := projectCurrentRealization input
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-realization-projection/v1"),
    ("lifecycle", lifecycleName projected.lifecycle),
    ("source_run_id", match projected.sourceRunId with
      | none => Json.null
      | some runId => runId)
  ]

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.RealizationProjectionProtocol
