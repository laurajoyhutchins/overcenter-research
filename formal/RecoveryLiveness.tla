---- MODULE RecoveryLiveness ----
EXTENDS Naturals

CONSTANTS
    W1, W2,
    MaxFence,
    MaxAttempts,
    EnableDeadLeaseReaping

Workers == {W1, W2}
NoWorker == "NoWorker"
WorkStates == {"Ready", "Executing", "Recovery", "Done", "Escalated"}
ProviderStates == {"None", "Pending", "Applied", "NoEffect"}
Observations == {"Unknown", "Present", "Absent"}

VARIABLE s
vars == <<s>>

CurrentAuthority(w) ==
    s.workerUp[w]
    /\ s.leaseLive
    /\ s.leaseOwner = w
    /\ s.leaseFence = s.fence

Terminal == s.work \in {"Done", "Escalated"}

Init ==
    s = [
        workerUp |-> [w \in Workers |-> TRUE],
        primaryCrashed |-> FALSE,
        leaseOwner |-> NoWorker,
        leaseLive |-> FALSE,
        fence |-> 0,
        leaseFence |-> 0,
        work |-> "Ready",
        provider |-> "None",
        observation |-> "Unknown",
        attempts |-> 0
        ]

Acquire(w) ==
    /\ s.workerUp[w]
    /\ ~s.leaseLive
    /\ ~Terminal
    /\ s.work \in {"Ready", "Recovery"}
    /\ s.fence < MaxFence
    /\ s' = [s EXCEPT
        !.leaseOwner = w,
        !.leaseLive = TRUE,
        !.fence = s.fence + 1,
        !.leaseFence = s.fence + 1
        ]

StartOrRetry(w) ==
    /\ CurrentAuthority(w)
    /\ s.attempts < MaxAttempts
    /\ (s.work = "Ready" \/ (s.work = "Recovery" /\ s.observation = "Absent"))
    /\ s' = [s EXCEPT
        !.work = "Executing",
        !.provider = "Pending",
        !.observation = "Unknown",
        !.attempts = @ + 1
        ]

CrashPrimary ==
    /\ ~s.primaryCrashed
    /\ s.workerUp[W1]
    /\ s' = [s EXCEPT
        !.workerUp = [s.workerUp EXCEPT ![W1] = FALSE],
        !.primaryCrashed = TRUE
        ]

ReapDeadLease ==
    /\ EnableDeadLeaseReaping
    /\ s.leaseLive
    /\ s.leaseOwner # NoWorker
    /\ ~s.workerUp[s.leaseOwner]
    /\ s' = [s EXCEPT
        !.leaseLive = FALSE,
        !.work = IF s.work = "Executing" THEN "Recovery" ELSE @
        ]

ResolveProvider ==
    /\ s.provider = "Pending"
    /\ \E result \in {"Applied", "NoEffect"} :
        s' = [s EXCEPT
            !.provider = result,
            !.work = "Recovery"
        ]

ObserveProvider ==
    /\ s.work = "Recovery"
    /\ s.observation = "Unknown"
    /\ s.provider \in {"Applied", "NoEffect"}
    /\ s' = [s EXCEPT
        !.observation = IF s.provider = "Applied" THEN "Present" ELSE "Absent"
        ]

AdvanceAfterObservation ==
    /\ s.work = "Recovery"
    /\ s.leaseLive
    /\ s.leaseOwner # NoWorker
    /\ s.workerUp[s.leaseOwner]
    /\ s.observation \in {"Present", "Absent"}
    /\ (s.observation = "Present" \/ s.attempts = MaxAttempts)
    /\ s' = [s EXCEPT !.work = IF s.observation = "Present" THEN "Done" ELSE "Escalated"]

AcquireAny == \E w \in Workers : Acquire(w)
StartAny == \E w \in Workers : StartOrRetry(w)

Next ==
    \/ AcquireAny
    \/ StartAny
    \/ CrashPrimary
    \/ ReapDeadLease
    \/ ResolveProvider
    \/ ObserveProvider
    \/ AdvanceAfterObservation
    \/ UNCHANGED vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(AcquireAny)
    /\ WF_vars(StartAny)
    /\ WF_vars(ReapDeadLease)
    /\ WF_vars(ResolveProvider)
    /\ WF_vars(ObserveProvider)
    /\ WF_vars(AdvanceAfterObservation)

TypeOK ==
    /\ s.workerUp \in [Workers -> BOOLEAN]
    /\ s.primaryCrashed \in BOOLEAN
    /\ s.leaseOwner \in Workers \cup {NoWorker}
    /\ s.leaseLive \in BOOLEAN
    /\ s.fence \in 0..MaxFence
    /\ s.leaseFence \in 0..MaxFence
    /\ s.work \in WorkStates
    /\ s.provider \in ProviderStates
    /\ s.observation \in Observations
    /\ s.attempts \in 0..MaxAttempts

EventuallyTerminal == <>Terminal

====
