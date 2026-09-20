import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Overcenter.AdmissionProofs
import Overcenter.TransactionKernel

open Lean

namespace Overcenter.AdmissionProtocol

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
private def mutationRunIdentity
    (request : Json) (prefix : String) : Except String MutationRunIdentity := do
  pure {
    id := ← stringField request s!"{prefix}_id"
    obligationId := ← stringField request s!"{prefix}_obligation_id"
    claimedRevision := ← stringField request s!"{prefix}_claimed_revision"
    claimCommit := ← stringField request s!"{prefix}_claim_commit"
    obligationKey := ← stringField request s!"{prefix}_obligation_key"
    executionGeneration := ← natField request s!"{prefix}_execution_generation"
    executionAuthorityCommit := ← stringField request s!"{prefix}_execution_authority_commit"
    executionCapabilitySha256 := ← stringField request s!"{prefix}_execution_capability_sha256"
  }

private def mutationAuthorityComparison (request : Json) : Except String Json := do
  let run ← mutationRunIdentity request "run"
  let rawPermit ← mutationRunIdentity request "permit"
  let permit : MutationPermitIdentity := {
    toMutationRunIdentity := rawPermit
    presentedCapabilitySha256 := ← stringField request "presented_capability_sha256"
  }
  let facts := projectMutationFacts run permit (← boolField request "unresolved_effect")
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-mutation-authority-comparison/v1"),
    ("current_authority", facts.currentAuthority),
    ("exact_revision", facts.exactRevision),
    ("mutation_allowed", (step facts .mutate).isSome)
  ]

private def reservationReplayComparison (request : Json) : Except String Json := do
  let run ← mutationRunIdentity request "run"
  let reservation : EffectReservationIdentity := {
    runId := ← stringField request "reservation_run_id"
    obligationId := ← stringField request "reservation_obligation_id"
    executionGeneration := ← natField request "reservation_execution_generation"
    executionAuthorityCommit := ← stringField request "reservation_execution_authority_commit"
  }
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-reservation-replay-comparison/v1"),
    ("admitted", reservationReplayAllowed run reservation (← boolField request "unresolved_effect"))
  ]

private def receiptReplayComparison (request : Json) : Except String Json := do
  let run ← mutationRunIdentity request "run"
  let receipt : ReceiptIdentity := {
    runId := ← stringField request "receipt_run_id"
    obligationId := ← stringField request "receipt_obligation_id"
    claimedRevision := ← stringField request "receipt_claimed_revision"
    claimCommit := ← stringField request "receipt_claim_commit"
    executionGeneration := ← natField request "receipt_execution_generation"
    executionAuthorityCommit := ← stringField request "receipt_execution_authority_commit"
  }
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-receipt-replay-comparison/v1"),
    ("admitted", receiptReplayAllowed run receipt)
  ]

private def executionAuthorityComparison (request : Json) : Except String Json := do
  let run ← mutationRunIdentity request "run"
  let authority : ExecutionAuthorityIdentity := {
    runId := ← stringField request "authority_run_id"
    obligationId := ← stringField request "authority_obligation_id"
    generation := ← natField request "authority_generation"
    previousAuthorityCommit := ← stringField request "authority_previous_commit"
  }
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-execution-authority-comparison/v1"),
    ("admitted", executionAuthorityAdvanceAllowed run authority)
  ]

private def transactionKernelComparison (request : Json) : Except String Json := do
  let facts : TransactionFacts := {
    currentAuthority := ← boolField request "current_authority"
    exactRevision := ← boolField request "exact_revision"
    unresolvedEffect := ← boolField request "unresolved_effect"
    verifiedPresent := ← boolField request "verified_present"
    verifiedAbsent := ← boolField request "verified_absent"
    verifiedExactRevision := ← boolField request "verified_exact_revision"
    settlementCompleted := ← boolField request "settlement_completed"
    settlementWasAuthorized := ← boolField request "settlement_was_authorized"
    settlementEvidenceMatches := ← boolField request "settlement_evidence_matches"
    evidenceValid := ← boolField request "evidence_valid"
  }
  pure <| Json.mkObj [
    ("schema", "overcenter-lean-transaction-kernel-comparison/v1"),
    ("mutation_allowed", (step facts .mutate).isSome),
    ("settlement_allowed", (step facts .settle).isSome),
    ("replay_allowed", (step facts .replay).isSome),
    ("done", done facts)
  ]

def handleComparisonJson (request : Json) : Except String Json := do
  let command ← stringField request "command"
  if command == "transaction-kernel" then
    transactionKernelComparison request
  else if command == "mutation-authority" then
    mutationAuthorityComparison request
  else if command == "reservation-replay" then
    reservationReplayComparison request
  else if command == "receipt-replay" then
    receiptReplayComparison request
  else if command == "execution-authority" then
    executionAuthorityComparison request
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
