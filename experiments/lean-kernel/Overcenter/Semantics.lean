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

def realizationStability (family : VerifierFamily) : RealizationStability :=
  match family with
  | .immutableArtifact => .immutable
  | .fileContent => .mutableExternal
  | .eventuallyConsistentFileContent => .mutableExternal
  | .githubCommitStatus => .mutableExternal
  | .kubernetesConfigMapExists => .mutableExternal

def sameObservationCoordinate (postcondition : Postcondition) (observation : Observation) : Bool :=
  postcondition.family == observation.family &&
  postcondition.verifierRevision == observation.verifierRevision &&
  postcondition.coordinate == observation.coordinate

def verifies (postcondition : Postcondition) (observation : Observation) : Bool :=
  sameObservationCoordinate postcondition observation &&
  observation.certainty == .present &&
  observation.actual == some postcondition.expected

def localFileEnoentAuthoritative (coordinate : String) (evidence : AbsenceEvidence) : Bool :=
  match evidence with
  | .localFileEnoent
      subjectCoordinate
      scopeCoordinate
      snapshotIsNull
      completenessKind
      completenessResult
      provenanceAdapter
      provenanceOperation
      provenanceErrorCode =>
      subjectCoordinate == coordinate &&
      scopeCoordinate == coordinate &&
      snapshotIsNull &&
      completenessKind == "direct-coordinate-read" &&
      completenessResult == "ENOENT" &&
      provenanceAdapter == "node:fs" &&
      provenanceOperation == "readFileSync" &&
      provenanceErrorCode == "ENOENT"
  | _ => false

def kubernetesAbsenceAuthoritative (coordinate : String) (evidence : AbsenceEvidence) : Bool :=
  match evidence with
  | .kubernetesCompleteList evidenceCoordinate complete =>
      evidenceCoordinate == coordinate && complete
  | _ => false

def authoritativeAbsence (postcondition : Postcondition) (observation : Observation) : Bool :=
  if !sameObservationCoordinate postcondition observation then
    false
  else if observation.certainty != .absent then
    false
  else
    match observation.absence with
    | none => false
    | some evidence =>
        match postcondition.family with
        | .fileContent => localFileEnoentAuthoritative postcondition.coordinate evidence
        | .kubernetesConfigMapExists => kubernetesAbsenceAuthoritative postcondition.coordinate evidence
        | _ => false

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
  if historical.disposition = .done then
    if historical.key = obligationKey current then
      match realizationStability current.postcondition.family with
      | .immutable => true
      | .mutableExternal =>
          match freshObservation with
          | none => false
          | some observation => verifies current.postcondition observation
    else
      false
  else
    false

end Overcenter
