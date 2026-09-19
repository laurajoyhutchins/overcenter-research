import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.SemanticIdentityProofs

open Lean

namespace Overcenter.SemanticIdentityProtocol

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

private def rejectTrustedSemanticIdentity (json : Json) : Except String Unit := do
  match field json "semantic_identity" with
  | .ok _ => throw "trusted semantic_identity is forbidden"
  | .error _ => pure ()
  match field json "semantic_identity_resolved" with
  | .ok _ => throw "trusted semantic_identity_resolved is forbidden"
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

private def selectorName : SemanticSelector → String
  | .verifiedContent => "verified-content"
  | .settlementReceipt => "settlement-receipt"

private def parseDependency (json : Json) : Except String RawClaimDependency := do
  rejectTrustedSemanticIdentity json
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

private def parseSemanticSource (json : Json) : Except String (Option NormalizedSemanticSource) := do
  if json.isNull then
    return none
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

private def parseEffect (json : Json) : Except String (Option ClaimEffect) := do
  if json.isNull then
    pure none
  else
    pure (some {
      resource := ← stringField json "resource"
      desired := ← stringField json "desired"
      sameDesiredCommutes := ← boolField json "same_desired_commutes"
    })

private def parseObligation (json : Json) : Except String RawClaimObligation := do
  let dependencyJson ← (← field json "dependencies").getArr?
  let dependencies ← dependencyJson.toList.mapM parseDependency
  pure {
    id := ← stringField json "id"
    dependencies
    semanticSource := ← parseSemanticSource (← field json "semantic_source")
    effect := ← parseEffect (← field json "effect")
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

private def semanticOutputJson : SemanticOutputMaterial → Json
  | .contentSha256 digest =>
      Json.mkObj [
        ("kind", "content-sha256"),
        ("digest", digest)
      ]
  | .githubCommitStatus repositoryId commitSha context state =>
      Json.mkObj [
        ("kind", "github-commit-status"),
        ("repository_id", repositoryId),
        ("commit_sha", commitSha),
        ("context", context),
        ("state", state)
      ]
  | .kubernetesExists authorityId apiGroup resource namespaceName name =>
      Json.mkObj [
        ("kind", "kubernetes-exists"),
        ("authority_id", authorityId),
        ("api_group", apiGroup),
        ("resource", resource),
        ("namespace", namespaceName),
        ("name", name)
      ]

private def identityMaterialJson : SemanticIdentityMaterial → Json
  | .output material =>
      Json.mkObj [
        ("kind", "output"),
        ("material", semanticOutputJson material)
      ]
  | .settlementReceipt commit =>
      Json.mkObj [
        ("kind", "settlement-receipt"),
        ("commit", commit)
      ]

private def findTargetDependency
    (ctx : RawClaimContext)
    (upstream : String)
    (selector : SemanticSelector) : Option RawClaimDependency := do
  let target ← findRawObligation ctx.obligations ctx.targetId
  target.dependencies.find? (fun dependency =>
    dependency.upstream == upstream &&
    dependency.kind == .semantic &&
    dependency.selector == some selector)

private def handleIdentity (request : Json) (ctx : RawClaimContext) : Except String Json := do
  let upstream ← stringField request "upstream"
  let selector ← parseSelector (← stringField request "selector")
  let dependency ← match findTargetDependency ctx upstream selector with
    | none => throw "semantic dependency not found on target"
    | some dependency => pure dependency
  let material := deriveSemanticIdentityMaterial ctx dependency
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-semantic-identity/v1"),
    ("upstream", upstream),
    ("selector", selectorName selector),
    ("resolved", material.isSome),
    ("identity_material",
      match material with
      | none => Json.null
      | some value => identityMaterialJson value)
  ]

private def handleAdmission (ctx : RawClaimContext) : Json :=
  Json.mkObj [
    ("schema", "overcenter-lean-derived-admission/v1"),
    ("admitted", derivedClaimAdmissible ctx)
  ]

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  let ctx ← parseContext request
  if command = "semantic-identity" then
    handleIdentity request ctx
  else if command = "claim-admission-derived" then
    pure (handleAdmission ctx)
  else
    throw s!"unsupported command: {command}"

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

end Overcenter.SemanticIdentityProtocol
