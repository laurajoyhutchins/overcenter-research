---- MODULE SchedulerLiveness ----
EXTENDS Naturals

CONSTANTS
    UseFairPolicy,
    AllowFreshFlood

Target == "RecoveredTarget"
Fresh == "FreshWork"
Choices == {Target, Fresh}

VARIABLES
    authorityAvailable,
    observationArrived,
    targetReady,
    targetClaimed,
    freshSeen,
    lastSelected,
    heartbeat

vars ==
    <<authorityAvailable,
      observationArrived,
      targetReady,
      targetClaimed,
      freshSeen,
      lastSelected,
      heartbeat>>

Init ==
    /\ authorityAvailable = FALSE
    /\ observationArrived = FALSE
    /\ targetReady = FALSE
    /\ targetClaimed = FALSE
    /\ freshSeen = FALSE
    /\ lastSelected = Target
    /\ heartbeat = FALSE

RestoreAuthority ==
    /\ ~authorityAvailable
    /\ authorityAvailable' = TRUE
    /\ UNCHANGED
        <<observationArrived,
          targetReady,
          targetClaimed,
          freshSeen,
          lastSelected,
          heartbeat>>

DeliverObservation ==
    /\ ~observationArrived
    /\ observationArrived' = TRUE
    /\ targetReady' = TRUE
    /\ UNCHANGED
        <<authorityAvailable,
          targetClaimed,
          freshSeen,
          lastSelected,
          heartbeat>>

FairChoice ==
    IF ~freshSeen
    THEN Fresh
    ELSE
        IF targetReady /\ ~targetClaimed
        THEN IF lastSelected = Fresh THEN Target ELSE Fresh
        ELSE Fresh

Chosen ==
    IF UseFairPolicy THEN FairChoice ELSE Fresh

Schedule ==
    /\ authorityAvailable
    /\ LET chosen == Chosen IN
        /\ chosen \in Choices
        /\ IF chosen = Target THEN targetReady /\ ~targetClaimed ELSE TRUE
        /\ targetClaimed' = (targetClaimed \/ (chosen = Target))
        /\ freshSeen' =
            IF chosen = Fresh
            THEN IF AllowFreshFlood THEN FALSE ELSE TRUE
            ELSE freshSeen
        /\ lastSelected' = chosen
        /\ heartbeat' = ~heartbeat
    /\ UNCHANGED <<authorityAvailable, observationArrived, targetReady>>

Next ==
    \/ RestoreAuthority
    \/ DeliverObservation
    \/ Schedule
    \/ UNCHANGED vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(RestoreAuthority)
    /\ WF_vars(DeliverObservation)
    /\ WF_vars(Schedule)

TypeOK ==
    /\ authorityAvailable \in BOOLEAN
    /\ observationArrived \in BOOLEAN
    /\ targetReady \in BOOLEAN
    /\ targetClaimed \in BOOLEAN
    /\ freshSeen \in BOOLEAN
    /\ lastSelected \in Choices
    /\ heartbeat \in BOOLEAN

TargetProgress ==
    targetReady ~> targetClaimed

====
