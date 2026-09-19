import Overcenter.Model

namespace Overcenter

inductive ClaimSemanticSelector where
  | verifiedContent
  | settlementReceipt
  deriving Repr, BEq, DecidableEq

inductive ClaimDependency where
  | control (upstream : String)
  | semantic (upstream : String) (selector : ClaimSemanticSelector)
  deriving Repr, BEq, DecidableEq

structure ClaimObligation where
  id : String
  packetIdentity : String
  postcondition : Postcondition
  dependencies : List ClaimDependency
  deriving Repr, BEq, DecidableEq

inductive ClaimSemanticIdentity where
  | verifiedContent
      (family : VerifierFamily)
      (coordinate : Coordinate)
      (expected : String)
  | settlementReceipt (commit : String)
  deriving Repr, BEq, DecidableEq

structure ClaimSemanticInput where
  selector : ClaimSemanticSelector
  identity : ClaimSemanticIdentity
  deriving Repr, BEq, DecidableEq

structure ClaimObligationKey where
  id : String
  packetIdentity : String
  postcondition : Postcondition
  semanticInputs : List ClaimSemanticInput
  deriving Repr, BEq, DecidableEq

inductive HistoricalClaimDisposition where
  | executing
  | waiting
  | recoveryRequired
  | done
  | ready
  deriving Repr, BEq, DecidableEq

structure HistoricalClaimRun where
  runId : String
  obligationId : String
  key : ClaimObligationKey
  disposition : HistoricalClaimDisposition
  settlementCommit : Option String
  deriving Repr, BEq, DecidableEq

inductive ClaimLifecycle where
  | unrealized
  | executing
  | waiting
  | recoveryRequired
  | done
  deriving Repr, BEq, DecidableEq

structure ClaimCandidate where
  runId : String
  obligationId : String
  parentRevision : String
  claimedRevision : String
  obligationKey : ClaimObligationKey
  capabilityDigest : String
  deriving Repr, BEq, DecidableEq

inductive ClaimAdmissionError where
  | unknownObligation
  | duplicateRun
  | revisionMismatch
  | claimWhileNotReady
  | unsatisfiedDependencies
  | unresolvedSemanticDependency
  | obligationKeyMismatch
  | invalidCapabilityDigest
  deriving Repr, BEq, DecidableEq

inductive ClaimAdmissionResult where
  | accepted
  | rejected (reason : ClaimAdmissionError)
  deriving Repr, BEq, DecidableEq

def claimDependencyUpstream : ClaimDependency → String
  | .control upstream => upstream
  | .semantic upstream _ => upstream

def findClaimObligation
    (obligations : List ClaimObligation)
    (id : String) : Option ClaimObligation :=
  obligations.find? (fun obligation => obligation.id == id)

def claimVerifiedContentIdentity
    (postcondition : Postcondition) : ClaimSemanticIdentity :=
  .verifiedContent
    postcondition.family
    postcondition.coordinate
    postcondition.expected

def claimSemanticInputKey (input : ClaimSemanticInput) : String :=
  match input.selector, input.identity with
  | .verifiedContent, .verifiedContent family coordinate expected =>
      s!"output:verified-content:{repr family}:{repr coordinate}:{expected}"
  | .settlementReceipt, .settlementReceipt commit =>
      s!"evidence:settlement-receipt:{commit}"
  | .verifiedContent, .settlementReceipt commit =>
      s!"invalid:output:{commit}"
  | .settlementReceipt, .verifiedContent family coordinate expected =>
      s!"invalid:evidence:{repr family}:{repr coordinate}:{expected}"

def insertClaimSemanticInput
    (input : ClaimSemanticInput) :
    List ClaimSemanticInput → List ClaimSemanticInput
  | [] => [input]
  | head :: rest =>
      if claimSemanticInputKey input <= claimSemanticInputKey head then
        input :: head :: rest
      else
        head :: insertClaimSemanticInput input rest

def sortClaimSemanticInputs :
    List ClaimSemanticInput → List ClaimSemanticInput
  | [] => []
  | head :: rest =>
      insertClaimSemanticInput head (sortClaimSemanticInputs rest)

def latestMatchingRun
    (runs : List HistoricalClaimRun)
    (obligationId : String)
    (key : ClaimObligationKey) : Option HistoricalClaimRun :=
  (runs.filter (fun run =>
    run.obligationId == obligationId && run.key == key)).getLast?

def latestDoneRun
    (runs : List HistoricalClaimRun)
    (obligationId : String)
    (key : ClaimObligationKey) : Option HistoricalClaimRun :=
  (runs.filter (fun run =>
    run.obligationId == obligationId &&
    run.key == key &&
    run.disposition == .done)).getLast?

mutual
  def deriveClaimLifecycle
      (obligations : List ClaimObligation)
      (runs : List HistoricalClaimRun)
      (id : String)
      (fuel : Nat) : Option ClaimLifecycle :=
    match fuel with
    | 0 => none
    | fuel + 1 =>
        match findClaimObligation obligations id with
        | none => none
        | some obligation =>
            match deriveClaimObligationKey obligations runs obligation fuel with
            | none => some .unrealized
            | some key =>
                match latestDoneRun runs id key with
                | some _ => some .done
                | none =>
                    match latestMatchingRun runs id key with
                    | none => some .unrealized
                    | some run =>
                        match run.disposition with
                        | .executing => some .executing
                        | .waiting => some .waiting
                        | .recoveryRequired => some .recoveryRequired
                        | .done => some .done
                        | .ready => some .unrealized

  def deriveClaimSemanticIdentity
      (obligations : List ClaimObligation)
      (runs : List HistoricalClaimRun)
      (upstream : String)
      (selector : ClaimSemanticSelector)
      (fuel : Nat) : Option ClaimSemanticIdentity :=
    match fuel with
    | 0 => none
    | fuel + 1 =>
        match findClaimObligation obligations upstream with
        | none => none
        | some upstreamObligation =>
            match deriveClaimObligationKey obligations runs upstreamObligation fuel with
            | none => none
            | some upstreamKey =>
                match latestDoneRun runs upstream upstreamKey with
                | none => none
                | some doneRun =>
                    match selector with
                    | .verifiedContent =>
                        some (claimVerifiedContentIdentity upstreamObligation.postcondition)
                    | .settlementReceipt =>
                        match doneRun.settlementCommit with
                        | none => none
                        | some commit => some (.settlementReceipt commit)

  def deriveClaimObligationKey
      (obligations : List ClaimObligation)
      (runs : List HistoricalClaimRun)
      (obligation : ClaimObligation)
      (fuel : Nat) : Option ClaimObligationKey :=
    match fuel with
    | 0 => none
    | fuel + 1 =>
        let semantic := obligation.dependencies.filterMap (fun dependency =>
          match dependency with
          | .control _ => none
          | .semantic upstream selector => some (upstream, selector))
        let rec consume :
            List (String × ClaimSemanticSelector) →
            Option (List ClaimSemanticInput)
          | [] => some []
          | (upstream, selector) :: rest =>
              match deriveClaimSemanticIdentity obligations runs upstream selector fuel with
              | none => none
              | some identity =>
                  match consume rest with
                  | none => none
                  | some tail => some ({ selector, identity } :: tail)
        match consume semantic with
        | none => none
        | some inputs =>
            some {
              id := obligation.id
              packetIdentity := obligation.packetIdentity
              postcondition := obligation.postcondition
              semanticInputs := sortClaimSemanticInputs inputs
            }
end

def claimDependenciesDone
    (obligations : List ClaimObligation)
    (runs : List HistoricalClaimRun)
    (obligation : ClaimObligation) : Bool :=
  obligation.dependencies.all (fun dependency =>
    deriveClaimLifecycle
      obligations
      runs
      (claimDependencyUpstream dependency)
      (obligations.length + 1) == some .done)

def validCapabilityDigest (digest : String) : Bool :=
  digest.length == 64 &&
  digest.data.all (fun char => "0123456789abcdef".contains char)

def admitClaim
    (currentRevision : String)
    (obligations : List ClaimObligation)
    (runs : List HistoricalClaimRun)
    (candidate : ClaimCandidate) : ClaimAdmissionResult :=
  match findClaimObligation obligations candidate.obligationId with
  | none => .rejected .unknownObligation
  | some obligation =>
      if runs.any (fun run => run.runId == candidate.runId) then
        .rejected .duplicateRun
      else if candidate.parentRevision != currentRevision ||
              candidate.claimedRevision != currentRevision ||
              candidate.parentRevision != candidate.claimedRevision then
        .rejected .revisionMismatch
      else
        match deriveClaimLifecycle
          obligations
          runs
          obligation.id
          (obligations.length + 1) with
        | none => .rejected .unresolvedSemanticDependency
        | some lifecycle =>
            if lifecycle != .unrealized then
              .rejected .claimWhileNotReady
            else if !claimDependenciesDone obligations runs obligation then
              .rejected .unsatisfiedDependencies
            else
              match deriveClaimObligationKey
                obligations
                runs
                obligation
                (obligations.length + 1) with
              | none => .rejected .unresolvedSemanticDependency
              | some expectedKey =>
                  if candidate.obligationKey != expectedKey then
                    .rejected .obligationKeyMismatch
                  else if !validCapabilityDigest candidate.capabilityDigest then
                    .rejected .invalidCapabilityDigest
                  else
                    .accepted

end Overcenter
