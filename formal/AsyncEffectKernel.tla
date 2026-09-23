---- MODULE AsyncEffectKernel ----
EXTENDS Naturals

CONSTANTS
    W1, W2,
    Q0, Q1,
    MaxFence,
    EnableFenceCheck,
    RequireTerminalityBeforeRetry,
    ProviderDeduplicatesRequestDelivery

Workers == {W1, W2}
Requests == {Q0, Q1}
NoWorker == "NoWorker"
Observations == {"Unknown", "Absent", "Present"}

VARIABLE s
vars == <<s>>

CurrentAuthority(w) ==
    s.workerUp[w]
    /\ s.leaseLive
    /\ s.leaseOwner = w
    /\ s.leaseFence = s.fence

AllPriorRequestsTerminal ==
    s.sent[Q0] /\ s.pending[Q0] = 0

Done ==
    s.settled /\ s.evidenceValid

Init ==
    s = [
        workerUp |-> [w \in Workers |-> TRUE],
        leaseOwner |-> NoWorker,
        leaseLive |-> FALSE,
        fence |-> 0,
        leaseFence |-> 0,
        sent |-> [q \in Requests |-> FALSE],
        pending |-> [q \in Requests |-> 0],
        appliedByRequest |-> [q \in Requests |-> FALSE],
        effectCount |-> 0,
        observation |-> "Unknown",
        absenceProvesFinality |-> FALSE,
        unsafeReplay |-> FALSE,
        badAuthorityUse |-> FALSE,
        settled |-> FALSE,
        evidenceValid |-> FALSE
    ]

Acquire(w) ==
    /\ s.workerUp[w]
    /\ ~s.leaseLive
    /\ s.fence < MaxFence
    /\ ~s.settled
    /\ s' = [s EXCEPT
        !.leaseOwner = w,
        !.leaseLive = TRUE,
        !.fence = s.fence + 1,
        !.leaseFence = s.fence + 1
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

BeginOriginal(w) ==
    /\ ~s.settled
    /\ ~s.sent[Q0]
    /\ (~EnableFenceCheck \/ CurrentAuthority(w))
    /\ s' = [s EXCEPT
        !.sent = [s.sent EXCEPT ![Q0] = TRUE],
        !.pending = [s.pending EXCEPT ![Q0] = 1],
        !.observation = "Unknown",
        !.absenceProvesFinality = FALSE,
        !.badAuthorityUse = s.badAuthorityUse \/ ~CurrentAuthority(w)
    ]

DuplicateInFlight(q) ==
    /\ s.sent[q]
    /\ s.pending[q] = 1
    /\ s' = [s EXCEPT !.pending = [s.pending EXCEPT ![q] = 2]]

Deliver(q) ==
    /\ s.pending[q] > 0
    /\ LET applies == ~ProviderDeduplicatesRequestDelivery \/ ~s.appliedByRequest[q]
       IN s' = [s EXCEPT
            !.pending = [s.pending EXCEPT ![q] = @ - 1],
            !.appliedByRequest = [s.appliedByRequest EXCEPT ![q] = TRUE],
            !.effectCount = IF applies THEN @ + 1 ELSE @
       ]

Drop(q) ==
    /\ s.pending[q] > 0
    /\ s' = [s EXCEPT !.pending = [s.pending EXCEPT ![q] = @ - 1]]

ObserveAbsent ==
    /\ s.effectCount = 0
    /\ s.sent[Q0]
    /\ s' = [s EXCEPT
        !.observation = "Absent",
        !.absenceProvesFinality = AllPriorRequestsTerminal
    ]

ObservePresent ==
    /\ s.effectCount > 0
    /\ s' = [s EXCEPT
        !.observation = "Present",
        !.absenceProvesFinality = FALSE
    ]

Retry(w) ==
    /\ ~s.settled
    /\ s.sent[Q0]
    /\ ~s.sent[Q1]
    /\ s.observation = "Absent"
    /\ (~EnableFenceCheck \/ CurrentAuthority(w))
    /\ (~RequireTerminalityBeforeRetry \/ s.absenceProvesFinality)
    /\ s' = [s EXCEPT
        !.sent = [s.sent EXCEPT ![Q1] = TRUE],
        !.pending = [s.pending EXCEPT ![Q1] = 1],
        !.observation = "Unknown",
        !.unsafeReplay = s.unsafeReplay \/ ~s.absenceProvesFinality,
        !.badAuthorityUse = s.badAuthorityUse \/ ~CurrentAuthority(w)
    ]

Settle(w) ==
    /\ ~s.settled
    /\ s.observation = "Present"
    /\ (~EnableFenceCheck \/ CurrentAuthority(w))
    /\ s' = [s EXCEPT
        !.settled = TRUE,
        !.badAuthorityUse = s.badAuthorityUse \/ ~CurrentAuthority(w)
    ]

PersistEvidence ==
    /\ s.settled
    /\ ~s.evidenceValid
    /\ s' = [s EXCEPT !.evidenceValid = TRUE]

Next ==
    \/ \E w \in Workers : Acquire(w)
    \/ ExpireLease
    \/ \E w \in Workers : Crash(w)
    \/ \E w \in Workers : Wake(w)
    \/ \E w \in Workers : BeginOriginal(w)
    \/ \E q \in Requests : DuplicateInFlight(q)
    \/ \E q \in Requests : Deliver(q)
    \/ \E q \in Requests : Drop(q)
    \/ ObserveAbsent
    \/ ObservePresent
    \/ \E w \in Workers : Retry(w)
    \/ \E w \in Workers : Settle(w)
    \/ PersistEvidence
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ s.workerUp \in [Workers -> BOOLEAN]
    /\ s.leaseOwner \in Workers \cup {NoWorker}
    /\ s.leaseLive \in BOOLEAN
    /\ s.fence \in 0..MaxFence
    /\ s.leaseFence \in 0..MaxFence
    /\ s.sent \in [Requests -> BOOLEAN]
    /\ s.pending \in [Requests -> 0..2]
    /\ s.appliedByRequest \in [Requests -> BOOLEAN]
    /\ s.effectCount \in 0..4
    /\ s.observation \in Observations
    /\ s.absenceProvesFinality \in BOOLEAN
    /\ s.unsafeReplay \in BOOLEAN
    /\ s.badAuthorityUse \in BOOLEAN
    /\ s.settled \in BOOLEAN
    /\ s.evidenceValid \in BOOLEAN

AuthoritySafety == ~s.badAuthorityUse
NoUnsafeReplay == ~s.unsafeReplay
NoDoubleExecution == s.effectCount <= 1
NoFalseDone == Done => s.effectCount = 1

====
