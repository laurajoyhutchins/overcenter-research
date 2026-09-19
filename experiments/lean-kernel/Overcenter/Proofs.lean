import Overcenter.Semantics

namespace Overcenter

theorem verifierRevision_is_material
    (obligation : Obligation)
    (revision : String)
    (changed : revision ≠ obligation.postcondition.verifierRevision) :
    obligationKey {
      obligation with
      postcondition := { obligation.postcondition with verifierRevision := revision }
    } ≠ obligationKey obligation := by
  intro equalKeys
  have equalRevision := congrArg ObligationKey.verifierRevision equalKeys
  simp [obligationKey] at equalRevision
  exact changed equalRevision

theorem done_implies_verified
    {postcondition : Postcondition}
    {observation : Observation}
    (settled : settle postcondition observation = .done) :
    verifies postcondition observation = true := by
  cases verified : verifies postcondition observation with
  | true => rfl
  | false =>
      cases absent : authoritativeAbsence postcondition observation <;>
        simp [settle, verified, absent] at settled

theorem ready_implies_authoritative_absence
    {postcondition : Postcondition}
    {observation : Observation}
    (settled : settle postcondition observation = .ready) :
    authoritativeAbsence postcondition observation = true := by
  cases verified : verifies postcondition observation with
  | true =>
      simp [settle, verified] at settled
  | false =>
      cases absent : authoritativeAbsence postcondition observation with
      | true => rfl
      | false =>
          simp [settle, verified, absent] at settled

theorem stale_key_never_reuses
    (current : Obligation)
    (historical : HistoricalRealization)
    (freshObservation : Option Observation)
    (stale : historical.key ≠ obligationKey current) :
    reusable current historical freshObservation = false := by
  simp [reusable, stale]

theorem mutable_external_without_fresh_observation_never_reuses
    (current : Obligation)
    (historical : HistoricalRealization)
    (mutableExternal : historical.stability = .mutableExternal) :
    reusable current historical none = false := by
  simp [reusable, mutableExternal]

private def filePostcondition : Postcondition := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := "/provider/a"
  expected := "A"
}

private def fileObligation : Obligation := {
  id := "a"
  packetIdentity := "sha256:packet-a"
  postcondition := filePostcondition
  semanticInputs := ["sha256:source-a"]
}

private def exactObservation : Observation := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := "/provider/a"
  certainty := .present
  actual := some "A"
}

private def wrongCoordinateObservation : Observation := {
  exactObservation with
  coordinate := "/provider/b"
}

private def uncertainObservation : Observation := {
  exactObservation with
  certainty := .uncertain
}

private def authoritativeAbsenceObservation : Observation := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := "/provider/a"
  certainty := .absent
  actual := none
  absence := some {
    kind := .localFileEnoent
    coordinate := "/provider/a"
    complete := true
  }
}

private def forgedAbsenceObservation : Observation := {
  authoritativeAbsenceObservation with
  absence := some {
    kind := .localFileEnoent
    coordinate := "/provider/b"
    complete := true
  }
}

private def mutableHistory : HistoricalRealization := {
  key := obligationKey fileObligation
  stability := .mutableExternal
  disposition := .done
}

private def immutableHistory : HistoricalRealization := {
  key := obligationKey fileObligation
  stability := .immutable
  disposition := .done
}

private def verifierChangedObligation : Obligation := {
  fileObligation with
  postcondition := {
    filePostcondition with
    verifierRevision := "file-content-equals/v1@semantics-2"
  }
}

example : settle filePostcondition exactObservation = .done := by decide
example : settle filePostcondition wrongCoordinateObservation = .recoveryRequired := by decide
example : settle filePostcondition uncertainObservation = .recoveryRequired := by decide
example : settle filePostcondition authoritativeAbsenceObservation = .ready := by decide
example : settle filePostcondition forgedAbsenceObservation = .recoveryRequired := by decide

-- Historical DONE is not enough for mutable provider state.
example : reusable fileObligation mutableHistory none = false := by decide
example : reusable fileObligation mutableHistory (some exactObservation) = true := by decide

-- Immutable realizations may reuse exact semantic identity without a fresh read.
example : reusable fileObligation immutableHistory none = true := by decide

-- Changing verifier semantics invalidates both historical identity and fresh evidence.
example : obligationKey verifierChangedObligation ≠ obligationKey fileObligation := by decide
example : reusable verifierChangedObligation mutableHistory (some exactObservation) = false := by decide

end Overcenter
