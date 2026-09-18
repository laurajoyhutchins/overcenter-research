---- MODULE TransitionKernel ----
EXTENDS Naturals

CONSTANTS
    W1, W2,
    R1, R2,
    MaxFence,
    EnableFenceCheck,
    EnableRevisionCheck,
    EnableReplayGuard,
    EnableReservationCheck,
    RequireEvidenceForDone

Workers == {W1, W2}
Revisions == {R1, R2}
NoWorker == "NoWorker"
NoRevision == "NoRevision"

Phases == {"Idle", "Authorized", "Mutating", "Uncertain", "EffectKnown", "Verified", "Settled"}
EffectTruths == {"Absent", "Present"}
MutationKnowledgeStates == {"None", "Possible", "Confirmed"}
VerifiedEffects == {"Unknown", "Absent", "Present"}
Settlements == {"None", "Completed"}

VARIABLE s
vars == <<s>>

CurrentFenceAuthority(w) ==
    s.workerUp[w]
    /\ s.leaseLive
    /\ s.leaseOwner = w
    /\ s.leaseFence = s.fence

ExactLeaseRevision == s.leaseRevision = s.authorityRevision

MutationAuthorityAllowed(w) ==
    (~EnableFenceCheck \/ CurrentFenceAuthority(w))
    /\ (~EnableRevisionCheck \/ ExactLeaseRevision)

SettlementAuthorityAllowed(w) ==
    (~EnableFenceCheck \/ CurrentFenceAuthority(w))
    /\ (~EnableRevisionCheck \/ ExactLeaseRevision)

ExactEvidenceAllowed ==
    ~EnableRevisionCheck \/ s.verifiedRevision = s.authorityRevision

ReplayEvidenceIsAbsence ==
    s.verifiedEffect = "Absent"
    /\ s.verifiedRevision = s.authorityRevision

Done ==
    s.settlement = "Completed"
    /\ s.settlementWasAuthorized
    /\ s.settlementEvidenceMatches
    /\ s.verifiedEffect = "Present"
    /\ s.verifiedRevision = s.settlementRevision
    /\ (IF RequireEvidenceForDone THEN s.evidenceValid ELSE TRUE)

Init ==
    s = [
        workerUp |-> [w \in Workers |-> TRUE],
        leaseOwner |-> NoWorker,
        leaseLive |-> FALSE,
        fence |-> 0,
        leaseFence |-> 0,
        authorityRevision |-> R1,
        leaseRevision |-> NoRevision,
        phase |-> "Idle",
        effectTruth |-> "Absent",
        mutationKnowledge |-> "None",
        unresolved |-> FALSE,
        mutationOwner |-> NoWorker,
        mutationFence |-> 0,
        mutationRevision |-> NoRevision,
        mutationAttempts |-> 0,
        mutationWasAuthorized |-> TRUE,
        reservationViolated |-> FALSE,
        verifiedEffect |-> "Unknown",
        verifiedRevision |-> NoRevision,
        replayWithoutAbsence |-> FALSE,
        settlement |-> "None",
        settlementRevision |-> NoRevision,
        settlementFence |-> 0,
        settlementWasAuthorized |-> TRUE,
        settlementEvidenceMatches |-> TRUE,
        settlementAcked |-> FALSE,
        evidenceValid |-> FALSE
    ]

Acquire(w) ==
    /\ s.workerUp[w]
    /\ ~s.leaseLive
    /\ s.fence < MaxFence
    /\ s.settlement = "None"
    /\ s' = [s EXCEPT
        !.leaseOwner = w,
        !.leaseLive = TRUE,
        !.fence = s.fence + 1,
        !.leaseFence = s.fence + 1,
        !.leaseRevision = s.authorityRevision,
        !.phase = "Authorized"
    ]

ExpireLease ==
    /\ s.leaseLive
    /\ s' = [s EXCEPT !.leaseLive = FALSE]

Crash(w) ==
    /\ s.workerUp[w]
    /\ s' = [s EXCEPT !.workerUp = [s.workerUp EXCEPT ![w] = FALSE]]

Wake(w) ==
    /\ ~s.workerUp[w]
    /\ s' = [s EXCEPT !.workerUp = [s.workerUp EXCEPT ![w] = TRUE]]

ChangeAuthorityRevision ==
    /\ s.settlement = "None"
    /\ \E r \in Revisions \ {s.authorityRevision} :
        s' = [s EXCEPT !.authorityRevision = r]

BeginMutation(w) ==
    /\ s.settlement = "None"
    /\ s.phase = "Authorized"
    /\ s.mutationAttempts < 2
    /\ MutationAuthorityAllowed(w)
    /\ (~EnableReservationCheck \/ ~s.unresolved)
    /\ s' = [s EXCEPT
        !.phase = "Mutating",
        !.mutationKnowledge = "None",
        !.unresolved = TRUE,
        !.mutationOwner = w,
        !.mutationFence = s.leaseFence,
        !.mutationRevision = s.leaseRevision,
        !.mutationAttempts = s.mutationAttempts + 1,
        !.mutationWasAuthorized = CurrentFenceAuthority(w) /\ ExactLeaseRevision,
        !.reservationViolated = s.reservationViolated \/ s.unresolved,
        !.verifiedEffect = "Unknown",
        !.verifiedRevision = NoRevision
    ]

MutationKnownPresent ==
    /\ s.phase = "Mutating"
    /\ s' = [s EXCEPT
        !.effectTruth = "Present",
        !.mutationKnowledge = "Confirmed",
        !.phase = "EffectKnown"
    ]

MutationKnownAbsent ==
    /\ s.phase = "Mutating"
    /\ s' = [s EXCEPT
        !.effectTruth = "Absent",
        !.mutationKnowledge = "None",
        !.unresolved = FALSE,
        !.phase = "Authorized"
    ]

MutationUncertain ==
    /\ s.phase = "Mutating"
    /\ \E truth \in EffectTruths :
        s' = [s EXCEPT
            !.effectTruth = truth,
            !.mutationKnowledge = "Possible",
            !.unresolved = TRUE,
            !.phase = "Uncertain"
        ]

Verify(w) ==
    /\ s.workerUp[w]
    /\ s.unresolved
    /\ s.phase \in {"Authorized", "Uncertain", "EffectKnown"}
    /\ s' = [s EXCEPT
        !.verifiedEffect = s.effectTruth,
        !.verifiedRevision = s.mutationRevision,
        !.phase = "Verified",
        !.unresolved = IF s.effectTruth = "Absent" THEN FALSE ELSE s.unresolved
    ]

RetryMutation(w) ==
    /\ s.settlement = "None"
    /\ s.phase = "Verified"
    /\ s.mutationAttempts < 2
    /\ MutationAuthorityAllowed(w)
    /\ (~EnableReplayGuard \/ ReplayEvidenceIsAbsence)
    /\ s' = [s EXCEPT
        !.phase = "Mutating",
        !.mutationKnowledge = "None",
        !.unresolved = TRUE,
        !.mutationOwner = w,
        !.mutationFence = s.leaseFence,
        !.mutationRevision = s.leaseRevision,
        !.mutationAttempts = s.mutationAttempts + 1,
        !.mutationWasAuthorized = CurrentFenceAuthority(w) /\ ExactLeaseRevision,
        !.replayWithoutAbsence = s.replayWithoutAbsence \/ ~ReplayEvidenceIsAbsence,
        !.verifiedEffect = "Unknown",
        !.verifiedRevision = NoRevision
    ]

Settle(w) ==
    /\ s.settlement = "None"
    /\ s.phase = "Verified"
    /\ s.verifiedEffect = "Present"
    /\ SettlementAuthorityAllowed(w)
    /\ ExactEvidenceAllowed
    /\ \E ack \in BOOLEAN :
        s' = [s EXCEPT
            !.settlement = "Completed",
            !.settlementRevision = s.authorityRevision,
            !.settlementFence = s.leaseFence,
            !.settlementWasAuthorized = CurrentFenceAuthority(w) /\ ExactLeaseRevision,
            !.settlementEvidenceMatches = s.verifiedRevision = s.authorityRevision,
            !.settlementAcked = ack,
            !.unresolved = FALSE,
            !.phase = "Settled"
        ]

RetrySettlement(w) ==
    /\ s.settlement = "Completed"
    /\ ~s.settlementAcked
    /\ SettlementAuthorityAllowed(w)
    /\ s.settlementRevision = s.authorityRevision
    /\ s.verifiedRevision = s.settlementRevision
    /\ s' = [s EXCEPT !.settlementAcked = TRUE]

PersistEvidence ==
    /\ s.settlement = "Completed"
    /\ ~s.evidenceValid
    /\ s' = [s EXCEPT !.evidenceValid = TRUE]

Next ==
    \/ \E w \in Workers : Acquire(w)
    \/ ExpireLease
    \/ \E w \in Workers : Crash(w)
    \/ \E w \in Workers : Wake(w)
    \/ ChangeAuthorityRevision
    \/ \E w \in Workers : BeginMutation(w)
    \/ MutationKnownPresent
    \/ MutationKnownAbsent
    \/ MutationUncertain
    \/ \E w \in Workers : Verify(w)
    \/ \E w \in Workers : RetryMutation(w)
    \/ \E w \in Workers : Settle(w)
    \/ \E w \in Workers : RetrySettlement(w)
    \/ PersistEvidence
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ s.workerUp \in [Workers -> BOOLEAN]
    /\ s.leaseOwner \in Workers \cup {NoWorker}
    /\ s.leaseLive \in BOOLEAN
    /\ s.fence \in 0..MaxFence
    /\ s.leaseFence \in 0..MaxFence
    /\ s.authorityRevision \in Revisions
    /\ s.leaseRevision \in Revisions \cup {NoRevision}
    /\ s.phase \in Phases
    /\ s.effectTruth \in EffectTruths
    /\ s.mutationKnowledge \in MutationKnowledgeStates
    /\ s.unresolved \in BOOLEAN
    /\ s.mutationOwner \in Workers \cup {NoWorker}
    /\ s.mutationFence \in 0..MaxFence
    /\ s.mutationRevision \in Revisions \cup {NoRevision}
    /\ s.mutationAttempts \in 0..2
    /\ s.mutationWasAuthorized \in BOOLEAN
    /\ s.reservationViolated \in BOOLEAN
    /\ s.verifiedEffect \in VerifiedEffects
    /\ s.verifiedRevision \in Revisions \cup {NoRevision}
    /\ s.replayWithoutAbsence \in BOOLEAN
    /\ s.settlement \in Settlements
    /\ s.settlementRevision \in Revisions \cup {NoRevision}
    /\ s.settlementFence \in 0..MaxFence
    /\ s.settlementWasAuthorized \in BOOLEAN
    /\ s.settlementEvidenceMatches \in BOOLEAN
    /\ s.settlementAcked \in BOOLEAN
    /\ s.evidenceValid \in BOOLEAN

MutationAuthoritySafety == s.mutationWasAuthorized
SettlementAuthoritySafety == s.settlement = "None" \/ s.settlementWasAuthorized
ExactRevisionEvidence == s.settlement = "None" \/ s.settlementEvidenceMatches
ReplaySafety == ~s.replayWithoutAbsence
ReservationSafety == ~s.reservationViolated
NoFalseDone == Done => s.evidenceValid

====
