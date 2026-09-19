import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.KeyPreimageProofs

open Lean

namespace Overcenter.KeyPreimageProtocol

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

private def rejectTrustedKeyMaterial (json : Json) : Except String Unit := do
  rejectField json "preimage_json"
  rejectField json "obligation_key"
  rejectField json "semantic_dependencies_sorted"

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

private def parseDependency (json : Json) : Except String RawClaimDependency := do
  rejectField json "semantic_identity"
  rejectField json "identity"
  let kind ← parseDependencyKind (← stringField json "kind")
  let selectorName ← optionalStringField json "selector"
  let selector ← match selectorName with
    | none => pure none
    | some value => pure (some (← parseSelector value))
  pure {
    upstream := ← stringField json "upstream"
    kind
    selector
  }

private def parseSemanticSource (json : Json) : Except String (Option NormalizedSemanticSource) := do
  if json.isNull then return none
  let kind ← stringField json "kind"
  if kind = "file-content" then
    return some (.fileContent (← stringField json "content_sha256"))
  if kind = "eventually-consistent-file-content" then
    return some (.eventuallyConsistentFileContent (← stringField json "content_sha256"))
  if kind = "github-commit-status" then
    return some (.githubCommitStatus
      (← stringField json "repository_id")
      (← stringField json "commit_sha")
      (← stringField json "context")
      (← stringField json "state"))
  if kind = "kubernetes-configmap-exists" then
    return some (.kubernetesConfigMapExists
      (← stringField json "authority_id")
      (← stringField json "api_group")
      (← stringField json "resource")
      (← stringField json "namespace")
      (← stringField json "name"))
  throw s!"unsupported semantic source: {kind}"

private def parseObligation (json : Json) : Except String RawClaimObligation := do
  let dependencyJson ← (← field json "dependencies").getArr?
  pure {
    id := ← stringField json "id"
    dependencies := ← dependencyJson.toList.mapM parseDependency
    semanticSource := ← parseSemanticSource (← field json "semantic_source")
    effect := none
  }

private def parseLifecycleFact (json : Json) : Except String RawClaimLifecycleFact := do
  pure {
    obligationId := ← stringField json "obligation_id"
    status := ← parseLifecycle (← stringField json "status")
    runId := ← optionalStringField json "run_id"
  }

private def parseReceiptDisposition : String → Except String RawReceiptDisposition
  | "DONE" => pure .done
  | "READY" => pure .ready
  | "WAITING" => pure .waiting
  | "RECOVERY_REQUIRED" => pure .recoveryRequired
  | other => throw s!"unsupported receipt disposition: {other}"

private def parseReceipt (json : Json) : Except String RawSettlementReceiptFact := do
  pure {
    runId := ← stringField json "run_id"
    obligationId := ← stringField json "obligation_id"
    disposition := ← parseReceiptDisposition (← stringField json "disposition")
    settlementCommit := ← optionalStringField json "settlement_commit"
  }

private def parseContext (json : Json) : Except String RawClaimContext := do
  let obligationJson ← (← field json "obligations").getArr?
  let lifecycleJson ← (← field json "lifecycles").getArr?
  let receiptJson ← (← field json "receipts").getArr?
  pure {
    currentRevision := ← stringField json "current_revision"
    expectedRevision := ← stringField json "expected_revision"
    targetId := ← stringField json "target_id"
    obligations := ← obligationJson.toList.mapM parseObligation
    lifecycles := ← lifecycleJson.toList.mapM parseLifecycleFact
    receipts := ← receiptJson.toList.mapM parseReceipt
  }

private def parseKeyInput (request : Json) : Except String ObligationKeyInput := do
  rejectTrustedKeyMaterial request
  let packet ← field request "packet"
  let postcondition ← field request "postcondition"
  let _ ← packet.getObj?
  let _ ← postcondition.getObj?
  pure {
    context := ← parseContext request
    packet
    postcondition
  }

private def parseHashResult (json : Json) : Except String KeyHashResult := do
  pure {
    bytes := ← stringField json "bytes"
    digest := ← stringField json "digest"
  }

private def parseHashResults (request : Json) : Except String (List KeyHashResult) := do
  let values ← (← field request "hash_results").getArr?
  values.toList.mapM parseHashResult

private def hashRequestJson (bytes : String) : Json :=
  Json.mkObj [("bytes", bytes)]

private def handleHashPlan (input : ObligationKeyInput) : Json :=
  match plannedIdentityHashBytes input.context with
  | none =>
      Json.mkObj [
        ("schema", "overcenter-lean-obligation-key-preimage/v1"),
        ("accepted", false),
        ("hash_requests", Json.arr #[])
      ]
  | some planned =>
      Json.mkObj [
        ("schema", "overcenter-lean-obligation-key-preimage/v1"),
        ("accepted", true),
        ("hash_requests", Json.arr (planned.toArray.map hashRequestJson))
      ]

private def handlePreimage
    (input : ObligationKeyInput)
    (results : List KeyHashResult) : Json :=
  match buildObligationKeyPreimage input results with
  | none =>
      Json.mkObj [
        ("schema", "overcenter-lean-obligation-key-preimage/v1"),
        ("accepted", false),
        ("preimage_json", Json.null)
      ]
  | some preimage =>
      Json.mkObj [
        ("schema", "overcenter-lean-obligation-key-preimage/v1"),
        ("accepted", true),
        ("preimage_json", preimage)
      ]

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  let input ← parseKeyInput request
  if command = "key-hash-plan" then
    pure (handleHashPlan input)
  else if command = "key-preimage" then
    pure (handlePreimage input (← parseHashResults request))
  else
    throw s!"unsupported command: {command}"

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.KeyPreimageProtocol
