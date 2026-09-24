---- MODULE DiffusingTermination ----
EXTENDS Naturals

CONSTANT UseDurableAccounting

VARIABLES
    parentActive,
    spawnAuthority,
    reserved,
    inFlight,
    childActive,
    childDone,
    discharged,
    complete

vars ==
    <<parentActive,
      spawnAuthority,
      reserved,
      inFlight,
      childActive,
      childDone,
      discharged,
      complete>>

Init ==
    /\ parentActive = TRUE
    /\ spawnAuthority = TRUE
    /\ reserved = FALSE
    /\ inFlight = FALSE
    /\ childActive = FALSE
    /\ childDone = FALSE
    /\ discharged = FALSE
    /\ complete = FALSE

Reserve ==
    /\ parentActive
    /\ spawnAuthority
    /\ ~reserved
    /\ reserved' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, inFlight, childActive, childDone, discharged, complete>>

Dispatch ==
    /\ reserved
    /\ ~discharged
    /\ ~inFlight
    /\ ~childActive
    /\ ~childDone
    /\ inFlight' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, childActive, childDone, discharged, complete>>

FinishParent ==
    /\ parentActive
    /\ parentActive' = FALSE
    /\ spawnAuthority' = FALSE
    /\ UNCHANGED <<reserved, inFlight, childActive, childDone, discharged, complete>>

BecomePassiveWithSpawnAuthority ==
    /\ parentActive
    /\ parentActive' = FALSE
    /\ UNCHANGED <<spawnAuthority, reserved, inFlight, childActive, childDone, discharged, complete>>

RevokeSpawnAuthority ==
    /\ ~parentActive
    /\ spawnAuthority
    /\ spawnAuthority' = FALSE
    /\ UNCHANGED <<parentActive, reserved, inFlight, childActive, childDone, discharged, complete>>

Deliver ==
    /\ inFlight
    /\ inFlight' = FALSE
    /\ childActive' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, childDone, discharged, complete>>

FinishChild ==
    /\ childActive
    /\ childActive' = FALSE
    /\ childDone' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, inFlight, discharged, complete>>

Discharge ==
    /\ reserved
    /\ childDone
    /\ ~discharged
    /\ discharged' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, inFlight, childActive, childDone, complete>>

CancelUndispatched ==
    /\ reserved
    /\ ~inFlight
    /\ ~childActive
    /\ ~childDone
    /\ ~parentActive
    /\ ~discharged
    /\ discharged' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, inFlight, childActive, childDone, complete>>

LocallyQuiet ==
    ~parentActive /\ ~childActive

CausallyQuiet ==
    LocallyQuiet
    /\ ~spawnAuthority
    /\ ~inFlight
    /\ (~reserved \/ discharged)

Detect ==
    /\ ~complete
    /\ IF UseDurableAccounting THEN CausallyQuiet ELSE LocallyQuiet
    /\ complete' = TRUE
    /\ UNCHANGED <<parentActive, spawnAuthority, reserved, inFlight, childActive, childDone, discharged>>

Next ==
    \/ Reserve
    \/ Dispatch
    \/ FinishParent
    \/ BecomePassiveWithSpawnAuthority
    \/ RevokeSpawnAuthority
    \/ Deliver
    \/ FinishChild
    \/ Discharge
    \/ CancelUndispatched
    \/ Detect
    \/ UNCHANGED vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(RevokeSpawnAuthority)
    /\ WF_vars(Detect)

TypeOK ==
    /\ parentActive \in BOOLEAN
    /\ spawnAuthority \in BOOLEAN
    /\ reserved \in BOOLEAN
    /\ inFlight \in BOOLEAN
    /\ childActive \in BOOLEAN
    /\ childDone \in BOOLEAN
    /\ discharged \in BOOLEAN
    /\ complete \in BOOLEAN

UnsafeOutstandingWork ==
    spawnAuthority
    \/ inFlight
    \/ childActive
    \/ (reserved /\ ~discharged)

NoFalseCompletion ==
    complete => ~UnsafeOutstandingWork

TerminalState ==
    ~parentActive /\ ~spawnAuthority /\ ~inFlight /\ ~childActive /\ (~reserved \/ discharged)

TerminalDetection ==
    TerminalState ~> complete

====
