import Overcenter.Semantics
import Overcenter.Execution

namespace Overcenter

inductive RealizationLifecycle where
  | unrealized
  | executing
  | waiting
  | recoveryRequired
  | done
  deriving Repr, BEq, DecidableEq

structure RealizationRun where
  runId : String
  obligationKey : String
  status : ExecutionStatus
  deriving Repr, BEq, DecidableEq

structure CurrentRealization where
  lifecycle : RealizationLifecycle
  sourceRunId : Option String := none
  executionRunId : Option String := none
  deriving Repr, BEq, DecidableEq

structure RealizationProjectionInput where
  postcondition : Postcondition
  currentKey : Option String
  runs : List RealizationRun
  freshObservation : Option Observation := none
  deriving Repr, BEq, DecidableEq

def executionNonterminal : ExecutionStatus → Bool
  | .executing => true
  | .waiting => true
  | .recoveryRequired => true
  | .done => false
  | .ready => false

def latestRunWhere
    (predicate : RealizationRun → Bool)
    (runs : List RealizationRun) : Option RealizationRun :=
  runs.reverse.find? predicate

def latestNonterminalRun (runs : List RealizationRun) : Option RealizationRun :=
  latestRunWhere (fun run => executionNonterminal run.status) runs

def latestMatchingDoneRun
    (key : String)
    (runs : List RealizationRun) : Option RealizationRun :=
  latestRunWhere
    (fun run => run.obligationKey == key && run.status == .done)
    runs

def currentFromExecution (run : RealizationRun) : CurrentRealization :=
  match run.status with
  | .executing => {
      lifecycle := .executing
      sourceRunId := some run.runId
      executionRunId := some run.runId
    }
  | .waiting => {
      lifecycle := .waiting
      sourceRunId := some run.runId
      executionRunId := some run.runId
    }
  | .recoveryRequired => {
      lifecycle := .recoveryRequired
      sourceRunId := some run.runId
      executionRunId := some run.runId
    }
  | .done => { lifecycle := .unrealized }
  | .ready => { lifecycle := .unrealized }

def unboundFreshObservation
    (_postcondition : Postcondition)
    (_fresh : Option Observation) : CurrentRealization :=
  -- A bare observation can prove the postcondition, but cannot prove that the
  -- observed state realizes the current semantic-input key. New realizations
  -- need key-bound provenance (for example a matching historical run or a
  -- future explicit realization certificate).
  { lifecycle := .unrealized }

def revalidateHistoricalDone
    (postcondition : Postcondition)
    (run : RealizationRun)
    (fresh : Option Observation) : CurrentRealization :=
  match realizationStability postcondition.family with
  | .immutable =>
      { lifecycle := .done, sourceRunId := some run.runId }
  | .mutableExternal =>
      match fresh with
      | none =>
          { lifecycle := .recoveryRequired, sourceRunId := some run.runId }
      | some observation =>
          match settle postcondition observation with
          | .done =>
              { lifecycle := .done, sourceRunId := some run.runId }
          | .ready =>
              { lifecycle := .unrealized }
          | .recoveryRequired =>
              { lifecycle := .recoveryRequired, sourceRunId := some run.runId }

def projectCurrentRealization
    (input : RealizationProjectionInput) : CurrentRealization :=
  match latestNonterminalRun input.runs with
  | some active =>
      match input.currentKey with
      | none =>
          {
            lifecycle := .recoveryRequired
            sourceRunId := some active.runId
            executionRunId := some active.runId
          }
      | some key =>
          if active.obligationKey == key then
            currentFromExecution active
          else
            {
            lifecycle := .recoveryRequired
            sourceRunId := some active.runId
            executionRunId := some active.runId
          }
  | none =>
      match input.currentKey with
      | none => { lifecycle := .unrealized }
      | some key =>
          match latestMatchingDoneRun key input.runs with
          | some historicalDone =>
              revalidateHistoricalDone
                input.postcondition
                historicalDone
                input.freshObservation
          | none =>
              unboundFreshObservation input.postcondition input.freshObservation

end Overcenter
