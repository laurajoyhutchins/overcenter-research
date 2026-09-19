import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.GraphTensorProofs

open Lean

namespace Overcenter.GraphTensorProtocol

private def field (json : Json) (name : String) : Except String Json :=
  json.getObjVal? name

private def stringField (json : Json) (name : String) : Except String String := do
  (← field json name).getStr?

private def optionalStringField
    (json : Json) (name : String) : Except String (Option String) := do
  let value ← field json name
  if value.isNull then pure none else pure (some (← value.getStr?))

private def rejectField (json : Json) (name : String) : Except String Unit := do
  match field json name with
  | .ok _ => throw s!"trusted {name} is forbidden"
  | .error _ => pure ()

private def parseLifecycle : String → Except String ClaimLifecycle
  | "UNREALIZED" => pure .unrealized
  | "EXECUTING" => pure .executing
  | "WAITING" => pure .waiting
  | "RECOVERY_REQUIRED" => pure .recoveryRequired
  | "DONE" => pure .done
  | other => throw s!"unsupported claim lifecycle: {other}"

private def parseDependencyKind : String → Except String ClaimDependencyKind
  | "control" => pure .control
  | "semantic" => pure .semantic
  | other => throw s!"unsupported dependency kind: {other}"

private def parseSelector : String → Except String SemanticSelector
  | "verified-content" => pure .verifiedContent
  | "settlement-receipt" => pure .settlementReceipt
  | other => throw s!"unsupported semantic selector: {other}"

private def parseRelation : String → Except String GraphTensorRelation
  | "control" => pure .control
  | "semantic-verified-content" => pure .semanticVerifiedContent
  | "semantic-settlement-receipt" => pure .semanticSettlementReceipt
  | other => throw s!"unsupported tensor relation: {other}"

private def parseDependency (json : Json) : Except String RawClaimDependency := do
  let kind ← parseDependencyKind (← stringField json "kind")
  let selectorName? ← optionalStringField json "selector"
  let selector ← match selectorName? with
    | none => pure none
    | some value => pure (some (← parseSelector value))
  pure {
    upstream := ← stringField json "upstream"
    kind
    selector
  }

private def parseObligation (json : Json) : Except String RawClaimObligation := do
  let dependencyJson ← (← field json "dependencies").getArr?
  pure {
    id := ← stringField json "id"
    dependencies := ← dependencyJson.toList.mapM parseDependency
    semanticSource := none
    effect := none
  }

private def parseLifecycleFact (json : Json) : Except String RawClaimLifecycleFact := do
  pure {
    obligationId := ← stringField json "obligation_id"
    status := ← parseLifecycle (← stringField json "status")
    runId := ← optionalStringField json "run_id"
  }

private def parseContext (json : Json) : Except String RawClaimContext := do
  let obligationJson ← (← field json "obligations").getArr?
  let lifecycleJson ← (← field json "lifecycles").getArr?
  pure {
    currentRevision := ← stringField json "current_revision"
    expectedRevision := ← stringField json "expected_revision"
    targetId := ← stringField json "target_id"
    obligations := ← obligationJson.toList.mapM parseObligation
    lifecycles := ← lifecycleJson.toList.mapM parseLifecycleFact
    receipts := []
  }

private def relationNamesJson : Json :=
  Json.arr #[
    Json.str "control",
    Json.str "semantic-verified-content",
    Json.str "semantic-settlement-receipt"
  ]

private def natJson (value : Nat) : Json := value

private def edgeIndexJson (entry : GraphTensorEntry) : Json :=
  Json.arr #[natJson entry.sourceIndex, natJson entry.targetIndex]

private def projectJson (projection : GraphTensorProjection) : Json :=
  Json.mkObj [
    ("schema", "overcenter-lean-graph-tensor/v1"),
    ("view_key", projection.viewKey),
    ("node_ids", Json.arr (projection.nodeIds.map Json.str).toArray),
    ("relation_names", relationNamesJson),
    ("edge_index", Json.arr (projection.entries.map edgeIndexJson).toArray),
    ("edge_type", Json.arr
      (projection.entries.map (fun entry =>
        natJson (graphTensorRelationCode entry.relation))).toArray)
  ]

private def handleProject (request : Json) : Except String Json := do
  for name in ["view_key", "node_ids", "edge_index", "edge_type", "relation_names"] do
    rejectField request name
  let ctx ← parseContext request
  match buildGraphTensor ctx with
  | none => throw "graph context is not projectable"
  | some projection => pure (projectJson projection)

private def handleVerify (request : Json) : Except String Json := do
  let ctx ← parseContext request
  let suppliedViewKey ← stringField request "view_key"
  let sourceId ← stringField request "source"
  let targetId ← stringField request "target"
  let leftRelation ← parseRelation (← stringField request "left_relation")
  let rightRelation ← parseRelation (← stringField request "right_relation")
  match buildGraphTensor ctx with
  | none =>
      pure <| Json.mkObj [
        ("schema", "overcenter-lean-graph-tensor-verification/v1"),
        ("accepted", false),
        ("reason", "invalid-graph")
      ]
  | some projection =>
      if projection.viewKey != suppliedViewKey then
        pure <| Json.mkObj [
          ("schema", "overcenter-lean-graph-tensor-verification/v1"),
          ("accepted", false),
          ("reason", "stale-view")
        ]
      else
        let accepted := hasTypedTwoHop
          (graphView ctx)
          sourceId targetId leftRelation rightRelation
        pure <| Json.mkObj [
          ("schema", "overcenter-lean-graph-tensor-verification/v1"),
          ("accepted", accepted),
          ("reason", if accepted then "verified" else "no-path")
        ]

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command = "tensor-project" then
    handleProject request
  else if command = "tensor-verify-two-hop" then
    handleVerify request
  else
    throw s!"unsupported command: {command}"

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.GraphTensorProtocol
