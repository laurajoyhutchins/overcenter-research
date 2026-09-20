namespace Overcenter

structure TransactionFacts where
  currentAuthority : Bool
  exactRevision : Bool
  unresolvedEffect : Bool
  verifiedPresent : Bool
  verifiedAbsent : Bool
  verifiedExactRevision : Bool
  settlementCompleted : Bool
  settlementWasAuthorized : Bool
  settlementEvidenceMatches : Bool
  evidenceValid : Bool
  deriving Repr, BEq

structure AbstractTransaction where
  currentAuthority : Bool
  exactRevision : Bool
  unresolvedEffect : Bool
  verifiedPresent : Bool
  verifiedAbsent : Bool
  verifiedExactRevision : Bool
  settlementCompleted : Bool
  settlementWasAuthorized : Bool
  settlementEvidenceMatches : Bool
  evidenceValid : Bool
  deriving Repr, BEq

inductive TransactionCommand where
  | mutate
  | settle
  | replay
  | persistEvidence
  deriving Repr, BEq, DecidableEq

def abstract (s : TransactionFacts) : AbstractTransaction := {
  currentAuthority := s.currentAuthority
  exactRevision := s.exactRevision
  unresolvedEffect := s.unresolvedEffect
  verifiedPresent := s.verifiedPresent
  verifiedAbsent := s.verifiedAbsent
  verifiedExactRevision := s.verifiedExactRevision
  settlementCompleted := s.settlementCompleted
  settlementWasAuthorized := s.settlementWasAuthorized
  settlementEvidenceMatches := s.settlementEvidenceMatches
  evidenceValid := s.evidenceValid
}

structure MutationRunIdentity where
  id : String
  obligationId : String
  claimedRevision : String
  claimCommit : String
  obligationKey : String
  executionGeneration : String
  executionAuthorityCommit : String
  executionCapabilitySha256 : String
  deriving Repr, BEq

structure MutationPermitIdentity extends MutationRunIdentity where
  presentedCapabilitySha256 : String
  deriving Repr, BEq

def currentMutationAuthority
    (run : MutationRunIdentity)
    (permit : MutationPermitIdentity) : Bool :=
  permit.id == run.id &&
  permit.obligationId == run.obligationId &&
  permit.executionGeneration == run.executionGeneration &&
  permit.executionAuthorityCommit == run.executionAuthorityCommit &&
  permit.executionCapabilitySha256 == run.executionCapabilitySha256 &&
  permit.presentedCapabilitySha256 == run.executionCapabilitySha256

def exactMutationRevision
    (run : MutationRunIdentity)
    (permit : MutationPermitIdentity) : Bool :=
  permit.claimedRevision == run.claimedRevision &&
  permit.claimCommit == run.claimCommit &&
  permit.obligationKey == run.obligationKey

def projectMutationFacts
    (run : MutationRunIdentity)
    (permit : MutationPermitIdentity)
    (unresolvedEffect : Bool) : TransactionFacts := {
  currentAuthority := currentMutationAuthority run permit
  exactRevision := exactMutationRevision run permit
  unresolvedEffect
  verifiedPresent := false
  verifiedAbsent := false
  verifiedExactRevision := false
  settlementCompleted := false
  settlementWasAuthorized := false
  settlementEvidenceMatches := false
  evidenceValid := false
}

structure EffectReservationIdentity where
  runId : String
  obligationId : String
  executionGeneration : String
  executionAuthorityCommit : String
  deriving Repr, BEq

def reservationReplayAllowed
    (run : MutationRunIdentity)
    (reservation : EffectReservationIdentity)
    (unresolvedEffect : Bool) : Bool :=
  reservation.runId == run.id &&
  reservation.obligationId == run.obligationId &&
  reservation.executionGeneration == run.executionGeneration &&
  reservation.executionAuthorityCommit == run.executionAuthorityCommit &&
  !unresolvedEffect

theorem reservation_replay_sound
    (run : MutationRunIdentity)
    (reservation : EffectReservationIdentity)
    (unresolvedEffect : Bool)
    (h : reservationReplayAllowed run reservation unresolvedEffect = true) :
    reservation.runId = run.id ∧
    reservation.obligationId = run.obligationId ∧
    reservation.executionGeneration = run.executionGeneration ∧
    reservation.executionAuthorityCommit = run.executionAuthorityCommit ∧
    unresolvedEffect = false := by
  simpa [reservationReplayAllowed, and_assoc] using h

structure ReceiptIdentity where
  runId : String
  obligationId : String
  claimedRevision : String
  claimCommit : String
  executionGeneration : String
  executionAuthorityCommit : String
  deriving Repr, BEq

def receiptReplayAllowed
    (run : MutationRunIdentity)
    (receipt : ReceiptIdentity) : Bool :=
  receipt.runId == run.id &&
  receipt.obligationId == run.obligationId &&
  receipt.claimedRevision == run.claimedRevision &&
  receipt.claimCommit == run.claimCommit &&
  receipt.executionGeneration == run.executionGeneration &&
  receipt.executionAuthorityCommit == run.executionAuthorityCommit

theorem receipt_replay_sound
    (run : MutationRunIdentity)
    (receipt : ReceiptIdentity)
    (h : receiptReplayAllowed run receipt = true) :
    receipt.runId = run.id ∧
    receipt.obligationId = run.obligationId ∧
    receipt.claimedRevision = run.claimedRevision ∧
    receipt.claimCommit = run.claimCommit ∧
    receipt.executionGeneration = run.executionGeneration ∧
    receipt.executionAuthorityCommit = run.executionAuthorityCommit := by
  simpa [receiptReplayAllowed, and_assoc] using h

def mutationAllowed (s : TransactionFacts) : Bool :=
  s.currentAuthority && s.exactRevision && !s.unresolvedEffect

def settlementAllowed (s : TransactionFacts) : Bool :=
  s.currentAuthority && s.exactRevision &&
  s.verifiedPresent && s.verifiedExactRevision

def replayAllowed (s : TransactionFacts) : Bool :=
  s.currentAuthority && s.exactRevision &&
  s.verifiedAbsent && s.verifiedExactRevision

def done (s : TransactionFacts) : Bool :=
  s.settlementCompleted && s.settlementWasAuthorized &&
  s.settlementEvidenceMatches && s.verifiedPresent &&
  s.verifiedExactRevision && s.evidenceValid

def abstractMutationAllowed (s : AbstractTransaction) : Bool :=
  s.currentAuthority && s.exactRevision && !s.unresolvedEffect

def abstractSettlementAllowed (s : AbstractTransaction) : Bool :=
  s.currentAuthority && s.exactRevision &&
  s.verifiedPresent && s.verifiedExactRevision

def abstractReplayAllowed (s : AbstractTransaction) : Bool :=
  s.currentAuthority && s.exactRevision &&
  s.verifiedAbsent && s.verifiedExactRevision

def afterMutation (s : TransactionFacts) : TransactionFacts :=
  { s with
    unresolvedEffect := true
    verifiedPresent := false
    verifiedAbsent := false
    verifiedExactRevision := false }

def afterSettlement (s : TransactionFacts) : TransactionFacts :=
  { s with
    unresolvedEffect := false
    settlementCompleted := true
    settlementWasAuthorized := true
    settlementEvidenceMatches := true }

def afterReplay (s : TransactionFacts) : TransactionFacts :=
  { s with
    unresolvedEffect := true
    verifiedPresent := false
    verifiedAbsent := false
    verifiedExactRevision := false }

def afterPersistEvidence (s : TransactionFacts) : TransactionFacts :=
  { s with evidenceValid := true }

def abstractAfterMutation (s : AbstractTransaction) : AbstractTransaction :=
  { s with
    unresolvedEffect := true
    verifiedPresent := false
    verifiedAbsent := false
    verifiedExactRevision := false }

def abstractAfterSettlement (s : AbstractTransaction) : AbstractTransaction :=
  { s with
    unresolvedEffect := false
    settlementCompleted := true
    settlementWasAuthorized := true
    settlementEvidenceMatches := true }

def abstractAfterReplay (s : AbstractTransaction) : AbstractTransaction :=
  { s with
    unresolvedEffect := true
    verifiedPresent := false
    verifiedAbsent := false
    verifiedExactRevision := false }

def abstractAfterPersistEvidence (s : AbstractTransaction) : AbstractTransaction :=
  { s with evidenceValid := true }

def step (s : TransactionFacts) : TransactionCommand → Option TransactionFacts
  | .mutate =>
      if mutationAllowed s = true then some (afterMutation s) else none
  | .settle =>
      if settlementAllowed s = true then some (afterSettlement s) else none
  | .replay =>
      if replayAllowed s = true then some (afterReplay s) else none
  | .persistEvidence =>
      if s.settlementCompleted = true then some (afterPersistEvidence s) else none

inductive AbstractNext : AbstractTransaction → AbstractTransaction → Prop where
  | mutate (s) (h : abstractMutationAllowed s = true) :
      AbstractNext s (abstractAfterMutation s)
  | settle (s) (h : abstractSettlementAllowed s = true) :
      AbstractNext s (abstractAfterSettlement s)
  | replay (s) (h : abstractReplayAllowed s = true) :
      AbstractNext s (abstractAfterReplay s)
  | persistEvidence (s) (h : s.settlementCompleted = true) :
      AbstractNext s (abstractAfterPersistEvidence s)

theorem projected_mutation_sound
    (run : MutationRunIdentity)
    (permit : MutationPermitIdentity)
    (unresolvedEffect : Bool)
    (h : mutationAllowed (projectMutationFacts run permit unresolvedEffect) = true) :
    currentMutationAuthority run permit = true ∧
    exactMutationRevision run permit = true ∧
    unresolvedEffect = false := by
  simpa [mutationAllowed, projectMutationFacts, and_assoc] using h

theorem step_refines
    {s s' : TransactionFacts}
    {command : TransactionCommand}
    (h : step s command = some s') :
    AbstractNext (abstract s) (abstract s') := by
  cases command with
  | mutate =>
      by_cases allowed : mutationAllowed s = true
      · simp [step, allowed] at h
        subst s'
        exact AbstractNext.mutate _ (by
          simpa [abstractMutationAllowed, abstract, mutationAllowed] using allowed)
      · simp [step, allowed] at h
  | settle =>
      by_cases allowed : settlementAllowed s = true
      · simp [step, allowed] at h
        subst s'
        exact AbstractNext.settle _ (by
          simpa [abstractSettlementAllowed, abstract, settlementAllowed] using allowed)
      · simp [step, allowed] at h
  | replay =>
      by_cases allowed : replayAllowed s = true
      · simp [step, allowed] at h
        subst s'
        exact AbstractNext.replay _ (by
          simpa [abstractReplayAllowed, abstract, replayAllowed] using allowed)
      · simp [step, allowed] at h
  | persistEvidence =>
      by_cases allowed : s.settlementCompleted = true
      · simp [step, allowed] at h
        subst s'
        exact AbstractNext.persistEvidence _ (by
          simpa [abstract] using allowed)
      · simp [step, allowed] at h

end Overcenter
