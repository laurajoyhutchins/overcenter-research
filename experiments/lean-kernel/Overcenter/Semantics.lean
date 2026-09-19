import Overcenter.Model

namespace Overcenter

def obligationKey (obligation : Obligation) : ObligationKey := {
  id := obligation.id
  packetIdentity := obligation.packetIdentity
  family := obligation.postcondition.family
  verifierRevision := obligation.postcondition.verifierRevision
  coordinate := obligation.postcondition.coordinate
  expected := obligation.postcondition.expected
  semanticInputs := obligation.semanticInputs
}

def sameObservationCoordinate (postcondition : Postcondition) (observation : Observation) : Bool :=
  postcondition.family == observation.family &&
  postcondition.verifierRevision == observation.verifierRevision &&
  postcondition.coordinate == observation.coordinate

def verifies (postcondition : Postcondition) (observation : Observation) : Bool :=
  sameObservationCoordinate postcondition observation &&
  observation.certainty == .present &&
  observation.actual == some postcondition.expected

def acceptsAbsenceKind (family : VerifierFamily) (kind : AbsenceKind) : Bool :=
  match family, kind with
  | .fileContent, .localFileEnoent => true
  | .kubernetesConfigMapExists, .kubernetesCompleteList => true
  | _, _ => false

def authoritativeAbsence (postcondition : Postcondition) (observation : Observation) : Bool :=
  match observation.absence with
  | none => false
  | some evidence =>
      sameObservationCoordinate postcondition observation &&
      observation.certainty == .absent &&
      evidence.coordinate == postcondition.coordinate &&
      evidence.complete &&
      acceptsAbsenceKind postcondition.family evidence.kind

def settle (postcondition : Postcondition) (observation : Observation) : Disposition :=
  match verifies postcondition observation with
  | true => .done
  | false =>
      match authoritativeAbsence postcondition observation with
      | true => .ready
      | false => .recoveryRequired

def reusable
    (current : Obligation)
    (historical : HistoricalRealization)
    (freshObservation : Option Observation) : Bool :=
  if historical.disposition != .done then
    false
  else if historical.key != obligationKey current then
    false
  else
    match historical.stability with
    | .immutable => true
    | .mutableExternal =>
        match freshObservation with
        | none => false
        | some observation => verifies current.postcondition observation

end Overcenter
