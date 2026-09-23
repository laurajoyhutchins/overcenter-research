---- MODULE SchedulerServiceAge ----
EXTENDS Naturals

CONSTANTS
    MaxOlder,
    AllowOlderMint

VARIABLES
    authorityAvailable,
    targetReady,
    targetClaimed,
    olderRemaining,
    youngerPulse,
    heartbeat

vars ==
    <<authorityAvailable,
      targetReady,
      targetClaimed,
      olderRemaining,
      youngerPulse,
      heartbeat>>

Init ==
    /\ authorityAvailable = FALSE
    /\ targetReady = FALSE
    /\ targetClaimed = FALSE
    /\ olderRemaining = MaxOlder
    /\ youngerPulse = FALSE
    /\ heartbeat = FALSE

RestoreAuthority ==
    /\ ~authorityAvailable
    /\ authorityAvailable' = TRUE
    /\ UNCHANGED
        <<targetReady,
          targetClaimed,
          olderRemaining,
          youngerPulse,
          heartbeat>>

MakeTargetReady ==
    /\ ~targetReady
    /\ targetReady' = TRUE
    /\ UNCHANGED
        <<authorityAvailable,
          targetClaimed,
          olderRemaining,
          youngerPulse,
          heartbeat>>

AdmitYounger ==
    /\ targetReady
    /\ ~targetClaimed
    /\ youngerPulse' = ~youngerPulse
    /\ UNCHANGED
        <<authorityAvailable,
          targetReady,
          targetClaimed,
          olderRemaining,
          heartbeat>>

MintOlder ==
    /\ AllowOlderMint
    /\ targetReady
    /\ ~targetClaimed
    /\ olderRemaining < MaxOlder
    /\ olderRemaining' = olderRemaining + 1
    /\ UNCHANGED
        <<authorityAvailable,
          targetReady,
          targetClaimed,
          youngerPulse,
          heartbeat>>

Schedule ==
    /\ authorityAvailable
    /\ targetReady
    /\ ~targetClaimed
    /\ IF olderRemaining > 0
          THEN
            /\ olderRemaining' = olderRemaining - 1
            /\ targetClaimed' = FALSE
          ELSE
            /\ olderRemaining' = olderRemaining
            /\ targetClaimed' = TRUE
    /\ heartbeat' = ~heartbeat
    /\ UNCHANGED <<authorityAvailable, targetReady, youngerPulse>>

Next ==
    \/ RestoreAuthority
    \/ MakeTargetReady
    \/ AdmitYounger
    \/ MintOlder
    \/ Schedule
    \/ UNCHANGED vars

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(RestoreAuthority)
    /\ WF_vars(MakeTargetReady)
    /\ WF_vars(AdmitYounger)
    /\ WF_vars(MintOlder)
    /\ WF_vars(Schedule)

TypeOK ==
    /\ authorityAvailable \in BOOLEAN
    /\ targetReady \in BOOLEAN
    /\ targetClaimed \in BOOLEAN
    /\ olderRemaining \in 0..MaxOlder
    /\ youngerPulse \in BOOLEAN
    /\ heartbeat \in BOOLEAN

TargetProgress ==
    targetReady ~> targetClaimed

====
