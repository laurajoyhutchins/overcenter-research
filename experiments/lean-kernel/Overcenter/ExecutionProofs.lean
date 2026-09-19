import Overcenter.Execution

namespace Overcenter

private def initialExecution : ExecutionState := {
  runId := "run-1"
  obligationId := "work"
  claimedRevision := "revision-a"
  claimCommit := "claim-a"
  generation := 1
  authorityCommit := "claim-a"
  capabilityDigest := "capability-1"
  status := .executing
  unresolvedEffect := false
}

private def rotate2 : ExecutionFact :=
  .rotateAuthority
    "authority-2"
    "run-1"
    "work"
    2
    "claim-a"
    "capability-2"

private def reserve2 : ExecutionFact :=
  .reserveEffect
    "reservation-2"
    "run-1"
    "work"
    2
    "authority-2"

private def terminated2 : ExecutionFact :=
  .receipt
    "terminated-2"
    "run-1"
    "work"
    "revision-a"
    "claim-a"
    2
    "authority-2"
    .executionTerminated

private def done2 : ExecutionFact :=
  .receipt
    "done-2"
    "run-1"
    "work"
    "revision-a"
    "claim-a"
    2
    "authority-2"
    (.observation .done)

example :
    (applyExecutionFact initialExecution rotate2).map (·.generation) = some 2 := by decide

-- Generation skipping, stale predecessor authority, and wrong run identity cannot rotate authority.
example :
    applyExecutionFact initialExecution (
      .rotateAuthority "authority-3" "run-1" "work" 3 "claim-a" "capability-3"
    ) = none := by decide
example :
    applyExecutionFact initialExecution (
      .rotateAuthority "authority-2" "run-1" "work" 2 "stale" "capability-2"
    ) = none := by decide
example :
    applyExecutionFact initialExecution (
      .rotateAuthority "authority-2" "other-run" "work" 2 "claim-a" "capability-2"
    ) = none := by decide

private def generation2 : ExecutionState :=
  (applyExecutionFact initialExecution rotate2).getD initialExecution

-- Reservations bind the exact current generation and authority commit.
example :
    (applyExecutionFact generation2 reserve2).map (·.unresolvedEffect) = some true := by decide
example :
    applyExecutionFact generation2 (
      .reserveEffect "reservation-stale" "run-1" "work" 1 "claim-a"
    ) = none := by decide
example :
    applyExecutionFact generation2 (
      .reserveEffect "reservation-stale" "run-1" "work" 2 "claim-a"
    ) = none := by decide

private def reserved2 : ExecutionState :=
  (applyExecutionFact generation2 reserve2).getD generation2

-- A second unresolved effect cannot be reserved.
example : applyExecutionFact reserved2 reserve2 = none := by decide

-- Judgment cannot downgrade a potentially mutating execution to WAITING.
example :
    applyExecutionFact reserved2 (
      .receipt
        "judgment-2"
        "run-1"
        "work"
        "revision-a"
        "claim-a"
        2
        "authority-2"
        .judgmentRequired
    ) = none := by decide

-- Termination preserves the unresolved reservation and moves to recovery.
example :
    (applyExecutionFact reserved2 terminated2).map (fun state =>
      (state.status, state.unresolvedEffect)) =
      some (.recoveryRequired, true) := by decide

-- Authoritative successful observation settles and clears the unresolved effect.
example :
    (applyExecutionFact reserved2 done2).map (fun state =>
      (state.status, state.unresolvedEffect)) =
      some (.done, false) := by decide

-- Stale receipt generation, authority, revision, or claim cannot settle.
example :
    applyExecutionFact reserved2 (
      .receipt "done" "run-1" "work" "revision-a" "claim-a" 1 "claim-a" (.observation .done)
    ) = none := by decide
example :
    applyExecutionFact reserved2 (
      .receipt "done" "run-1" "work" "revision-a" "claim-a" 2 "stale" (.observation .done)
    ) = none := by decide
example :
    applyExecutionFact reserved2 (
      .receipt "done" "run-1" "work" "revision-b" "claim-a" 2 "authority-2" (.observation .done)
    ) = none := by decide
example :
    applyExecutionFact reserved2 (
      .receipt "done" "run-1" "work" "revision-a" "other-claim" 2 "authority-2" (.observation .done)
    ) = none := by decide

-- Terminal settlement cannot be followed by authority rotation or another receipt.
private def terminalDone : ExecutionState :=
  (applyExecutionFact reserved2 done2).getD reserved2

example : applyExecutionFact terminalDone rotate2 = none := by decide
example : applyExecutionFact terminalDone done2 = none := by decide

-- Replay is a pure fold over durable facts.
example :
    (replayExecutionFacts initialExecution [rotate2, reserve2, terminated2]).map (fun state =>
      (state.generation, state.status, state.unresolvedEffect)) =
      some (2, .recoveryRequired, true) := by decide

end Overcenter
