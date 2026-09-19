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

def localFileEnoentAuthoritative (coordinate : Coordinate) (evidence : AbsenceEvidence) : Bool :=
  match coordinate, evidence with
  | .opaque path,
    .localFileEnoent
      subjectCoordinate
      scopeCoordinate
      snapshotIsNull
      completenessKind
      completenessResult
      provenanceAdapter
      provenanceOperation
      provenanceErrorCode =>
      subjectCoordinate == path &&
      scopeCoordinate == path &&
      snapshotIsNull &&
      completenessKind == "direct-coordinate-read" &&
      completenessResult == "ENOENT" &&
      provenanceAdapter == "node:fs" &&
      provenanceOperation == "readFileSync" &&
      provenanceErrorCode == "ENOENT"
  | _, _ => false

def validKubernetesMember
    (namespace targetName : String)
    (member : KubernetesListMember) : Bool :=
  !member.name.isEmpty &&
  member.namespace == namespace &&
  !member.uid.isEmpty &&
  !member.resourceVersion.isEmpty &&
  member.name != targetName

def validKubernetesPage
    (namespace targetName snapshotResourceVersion : String)
    (expectedRequest : Option String)
    (page : KubernetesListPage) : Bool :=
  page.requestContinue == expectedRequest &&
  page.snapshotResourceVersion == snapshotResourceVersion &&
  page.members.all (validKubernetesMember namespace targetName)

def validKubernetesPages
    (namespace targetName snapshotResourceVersion : String)
    (expectedRequest : Option String) :
    List KubernetesListPage → Bool
  | [] => false
  | page :: [] =>
      validKubernetesPage namespace targetName snapshotResourceVersion expectedRequest page &&
      page.responseContinue == ""
  | page :: next :: rest =>
      validKubernetesPage namespace targetName snapshotResourceVersion expectedRequest page &&
      !page.responseContinue.isEmpty &&
      validKubernetesPages
        namespace
        targetName
        snapshotResourceVersion
        (some page.responseContinue)
        (next :: rest)

def kubernetesAbsenceAuthoritative (coordinate : Coordinate) (evidence : AbsenceEvidence) : Bool :=
  match coordinate, evidence with
  | .kubernetesConfigMap authorityId namespace targetName,
    .kubernetesCompleteList
      evidenceAuthorityId
      evidenceNamespace
      evidenceTargetName
      snapshotResourceVersion
      pages =>
      evidenceAuthorityId == authorityId &&
      evidenceNamespace == namespace &&
      evidenceTargetName == targetName &&
      !snapshotResourceVersion.isEmpty &&
      validKubernetesPages namespace targetName snapshotResourceVersion none pages
  | _, _ => false

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
