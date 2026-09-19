namespace Overcenter

inductive ExecutionStatus where
  | executing
  | waiting
  | recoveryRequired
  | done
  | ready
  deriving Repr, BEq, DecidableEq

structure ExecutionState where
  runId : String
  obligationId : String
  claimedRevision : String
  claimCommit : String
  generation : Nat
  authorityCommit : String
  capabilityDigest : String
  status : ExecutionStatus
  unresolvedEffect : Bool
  deriving Repr, BEq, DecidableEq

inductive ObservationDisposition where
  | done
  | ready
  | recoveryRequired
  deriving Repr, BEq, DecidableEq

inductive ExecutionReceiptKind where
  | observation (disposition : ObservationDisposition)
  | judgmentRequired
  | executionTerminated
  deriving Repr, BEq, DecidableEq

inductive ExecutionFact where
  | rotateAuthority
      (commit : String)
      (runId : String)
      (obligationId : String)
      (generation : Nat)
      (previousAuthorityCommit : String)
      (capabilityDigest : String)
  | reserveEffect
      (commit : String)
      (runId : String)
      (obligationId : String)
      (generation : Nat)
      (authorityCommit : String)
  | receipt
      (commit : String)
      (runId : String)
      (obligationId : String)
      (claimedRevision : String)
      (claimCommit : String)
      (generation : Nat)
      (authorityCommit : String)
      (kind : ExecutionReceiptKind)
  deriving Repr, BEq, DecidableEq

def executionStatusResolvable : ExecutionStatus → Bool
  | .executing => true
  | .waiting => true
  | .recoveryRequired => true
  | .done => false
  | .ready => false

def executionStatusRotatable := executionStatusResolvable

def applyExecutionFact
    (state : ExecutionState)
    (fact : ExecutionFact) : Option ExecutionState :=
  match fact with
  | .rotateAuthority commit runId obligationId generation previousAuthorityCommit capabilityDigest =>
      if !executionStatusRotatable state.status then
        none
      else if runId != state.runId || obligationId != state.obligationId then
        none
      else if generation != state.generation + 1 then
        none
      else if previousAuthorityCommit != state.authorityCommit then
        none
      else if capabilityDigest.isEmpty then
        none
      else
        some {
          state with
          generation
          authorityCommit := commit
          capabilityDigest
        }
  | .reserveEffect _ runId obligationId generation authorityCommit =>
      if state.status != .executing then
        none
      else if state.unresolvedEffect then
        none
      else if runId != state.runId || obligationId != state.obligationId then
        none
      else if generation != state.generation || authorityCommit != state.authorityCommit then
        none
      else
        some { state with unresolvedEffect := true }
  | .receipt _ runId obligationId claimedRevision claimCommit generation authorityCommit kind =>
      if !executionStatusResolvable state.status then
        none
      else if runId != state.runId || obligationId != state.obligationId then
        none
      else if claimedRevision != state.claimedRevision || claimCommit != state.claimCommit then
        none
      else if generation != state.generation || authorityCommit != state.authorityCommit then
        none
      else
        match kind with
        | .judgmentRequired =>
            if state.status != .executing || state.unresolvedEffect then
              none
            else
              some { state with status := .waiting }
        | .executionTerminated =>
            if state.status != .executing then
              none
            else
              some { state with status := .recoveryRequired }
        | .observation disposition =>
            match disposition with
            | .done =>
                some {
                  state with
                  status := .done
                  unresolvedEffect := false
                }
            | .ready =>
                some {
                  state with
                  status := .ready
                  unresolvedEffect := false
                }
            | .recoveryRequired =>
                some { state with status := .recoveryRequired }

def replayExecutionFacts :
    ExecutionState → List ExecutionFact → Option ExecutionState
  | state, [] => some state
  | state, fact :: rest =>
      match applyExecutionFact state fact with
      | none => none
      | some next => replayExecutionFacts next rest

end Overcenter
