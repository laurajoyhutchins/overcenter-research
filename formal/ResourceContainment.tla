---- MODULE ResourceContainment ----
EXTENDS Naturals

CONSTANTS
    L1, L2,
    RequireExactLeafIdentity,
    RequireEmptyBeforeEvidence

Leaves == {L1, L2}
NoLeaf == "NoLeaf"

Phases == {
    "Idle",
    "Running",
    "ChildClosed",
    "KillRequested",
    "Empty",
    "Observed",
    "Removed"
}

VARIABLE s
vars == <<s>>

Init ==
    s = [
        phase |-> "Idle",
        activeLeaf |-> NoLeaf,
        populated |-> FALSE,
        killedLeaf |-> NoLeaf,
        evidenceLeaf |-> NoLeaf,
        evidenceFinal |-> FALSE,
        removedLeaf |-> NoLeaf,
        wrongLeafTouched |-> FALSE
    ]

Start(l) ==
    /\ s.phase = "Idle"
    /\ l \in Leaves
    /\ s' = [s EXCEPT
        !.phase = "Running",
        !.activeLeaf = l,
        !.populated = TRUE,
        !.killedLeaf = NoLeaf,
        !.evidenceLeaf = NoLeaf,
        !.evidenceFinal = FALSE,
        !.removedLeaf = NoLeaf,
        !.wrongLeafTouched = FALSE
    ]

ChildCloses ==
    /\ s.phase = "Running"
    /\ s' = [s EXCEPT !.phase = "ChildClosed"]

Kill(l) ==
    /\ s.phase = "ChildClosed"
    /\ l \in Leaves
    /\ (~RequireExactLeafIdentity \/ l = s.activeLeaf)
    /\ s' = [s EXCEPT
        !.phase = "KillRequested",
        !.killedLeaf = l,
        !.wrongLeafTouched = s.wrongLeafTouched \/ l # s.activeLeaf
    ]

ObserveEmpty ==
    /\ s.phase = "KillRequested"
    /\ s.killedLeaf = s.activeLeaf
    /\ s' = [s EXCEPT
        !.phase = "Empty",
        !.populated = FALSE
    ]

CaptureEvidence(l) ==
    /\ s.phase \in {"ChildClosed", "KillRequested", "Empty"}
    /\ l \in Leaves
    /\ (~RequireExactLeafIdentity \/ l = s.activeLeaf)
    /\ (~RequireEmptyBeforeEvidence \/ ~s.populated)
    /\ s' = [s EXCEPT
        !.phase = "Observed",
        !.evidenceLeaf = l,
        !.evidenceFinal =
            l = s.activeLeaf
            /\ ~s.populated
            /\ s.killedLeaf = s.activeLeaf,
        !.wrongLeafTouched = s.wrongLeafTouched \/ l # s.activeLeaf
    ]

Remove(l) ==
    /\ s.phase = "Observed"
    /\ l \in Leaves
    /\ (~RequireExactLeafIdentity \/ l = s.activeLeaf)
    /\ s' = [s EXCEPT
        !.phase = "Removed",
        !.removedLeaf = l,
        !.wrongLeafTouched = s.wrongLeafTouched \/ l # s.activeLeaf
    ]

Next ==
    \/ \E l \in Leaves : Start(l)
    \/ ChildCloses
    \/ \E l \in Leaves : Kill(l)
    \/ ObserveEmpty
    \/ \E l \in Leaves : CaptureEvidence(l)
    \/ \E l \in Leaves : Remove(l)
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ s.phase \in Phases
    /\ s.activeLeaf \in Leaves \cup {NoLeaf}
    /\ s.populated \in BOOLEAN
    /\ s.killedLeaf \in Leaves \cup {NoLeaf}
    /\ s.evidenceLeaf \in Leaves \cup {NoLeaf}
    /\ s.evidenceFinal \in BOOLEAN
    /\ s.removedLeaf \in Leaves \cup {NoLeaf}
    /\ s.wrongLeafTouched \in BOOLEAN

ExactLeafAuthority ==
    /\ ~s.wrongLeafTouched
    /\ (s.killedLeaf = NoLeaf \/ s.killedLeaf = s.activeLeaf)
    /\ (s.evidenceLeaf = NoLeaf \/ s.evidenceLeaf = s.activeLeaf)
    /\ (s.removedLeaf = NoLeaf \/ s.removedLeaf = s.activeLeaf)

FinalEvidenceSafety ==
    s.evidenceLeaf = NoLeaf \/ s.evidenceFinal

RemovalSafety ==
    s.phase # "Removed"
    \/ (
        s.removedLeaf = s.activeLeaf
        /\ s.evidenceFinal
        /\ ~s.populated
    )

====
