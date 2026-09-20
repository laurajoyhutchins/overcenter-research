import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.AdmissionProofs

open Lean

namespace Overcenter.AdmissionProtocol

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

private def parseDependency (json : Json) : Except String ClaimDependency := do
  pure {
    upstream := ← stringField json "upstream"
    kind := ← parseDependencyKind (← stringField json "kind")
    semanticIdentity := ← optionalStringField json "semantic_identity"
  }

private def parseEffect (json : Json) : Except String (Option ClaimEffect) := do
  if json.isNull then
    pure none
  else
    pure (some {
      resource := ← stringField json "resource"
      desired := ← stringField json "desired"
      sameDesiredCommutes := ← boolField json "same_desired_commutes"
    })

private def parseObligation (json : Json) : Except String ClaimObligation := do
  let dependencyJson ← (← field json "dependencies").getArr?
  let dependencies ← dependencyJson.toList.mapM parseDependency
  pure {
    id := ← stringField json "id"
    dependencies
    effect := ← parseEffect (← field json "effect")
  }

private def parseLifecycleFact (json : Json) : Except String ClaimLifecycleFact := do
  pure {
    obligationId := ← stringField json "obligation_id"
    status := ← parseLifecycle (← stringField json "status")
  }

private def parseContext (json : Json) : Except String ClaimContext := do
  let obligationJson ← (← field json "obligations").getArr?
  let lifecycleJson ← (← field json "lifecycles").getArr?
  pure {
    currentRevision := ← stringField json "current_revision"
    expectedRevision := ← stringField json "expected_revision"
    targetId := ← stringField json "target_id"
    obligations := ← obligationJson.toList.mapM parseObligation
    lifecycles := ← lifecycleJson.toList.mapM parseLifecycleFact
  }

def handleJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command != "claim-admission" then
    throw s!"unsupported command: {command}"
  let ctx ← parseContext request
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-claim-admission/v1"),
    ("admitted", claimAdmissible ctx)
  ]

def handle (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleJson request).compress

/--
Test-only comparison surface. It deliberately reuses the production parser but
does not add another production command. The comparison executable built by the
runtime experiment calls this function directly.
-/
private def transactionKernelComparison (request : Json) : Except String Json := do
  let currentAuthority ← boolField request "current_authority"
  let exactRevision ← boolField request "exact_revision"
  let unresolvedEffect ← boolField request "unresolved_effect"
  let verifiedPresent ← boolField request "verified_present"
  let verifiedAbsent ← boolField request "verified_absent"
  let verifiedExactRevision ← boolField request "verified_exact_revision"
  let settlementCompleted ← boolField request "settlement_completed"
  let settlementWasAuthorized ← boolField request "settlement_was_authorized"
  let settlementEvidenceMatches ← boolField request "settlement_evidence_matches"
  let evidenceValid ← boolField request "evidence_valid"
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-transaction-kernel-comparison/v1"),
    ("mutation_allowed", currentAuthority && exactRevision && !unresolvedEffect),
    ("settlement_allowed", currentAuthority && exactRevision && verifiedPresent && verifiedExactRevision),
    ("replay_allowed", currentAuthority && exactRevision && verifiedAbsent && verifiedExactRevision),
    ("done", settlementCompleted && settlementWasAuthorized && settlementEvidenceMatches &&
      verifiedPresent && verifiedExactRevision && evidenceValid)
  ]

def handleComparisonJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command == "transaction-kernel" then
    transactionKernelComparison request
  else
    if command != "claim-admission" then
      throw s!"unsupported command: {command}"
    let ctx ← parseContext request
    pure <| Json.mkObj [
      ("schema", "overcenter-lean-claim-admission-comparison/v1"),
      ("graph_acyclic", claimGraphAcyclic ctx),
      ("optimized_dependencies_done", claimDependenciesDone ctx),
      ("reference_dependencies_done", claimDependenciesDoneReference ctx),
      ("optimized_effect_conflict", claimUnorderedEffectConflict ctx),
      ("reference_effect_conflict", claimUnorderedEffectConflictReference ctx)
    ]

def handleComparison (input : String) : Except String String := do
  let request ← Json.parse input
  pure (← handleComparisonJson request).compress

end Overcenter.AdmissionProtocol
