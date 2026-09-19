import Overcenter.Model

namespace Overcenter

inductive KubernetesListState where
  | present
  | absent
  | indeterminate
  deriving Repr, BEq, DecidableEq

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
    (namespaceName : String)
    (member : KubernetesListMember) : Bool :=
  !member.name.isEmpty &&
  member.namespaceName == namespaceName &&
  !member.uid.isEmpty &&
  !member.resourceVersion.isEmpty

def validKubernetesPage
    (authorityId namespaceName snapshotResourceVersion : String)
    (expectedRequest : Option String)
    (page : KubernetesListPage) : Bool :=
  page.authorityId == authorityId &&
  page.requestNamespace == namespaceName &&
  page.requestContinue == expectedRequest &&
  page.snapshotResourceVersion == snapshotResourceVersion &&
  page.members.all (validKubernetesMember namespaceName)

def validKubernetesPages
    (authorityId namespaceName snapshotResourceVersion : String)
    (expectedRequest : Option String) :
    List KubernetesListPage → Bool
  | [] => false
  | page :: [] =>
      validKubernetesPage authorityId namespaceName snapshotResourceVersion expectedRequest page &&
      page.responseContinue == ""
  | page :: next :: rest =>
      validKubernetesPage authorityId namespaceName snapshotResourceVersion expectedRequest page &&
      !page.responseContinue.isEmpty &&
      validKubernetesPages
        authorityId
        namespaceName
        snapshotResourceVersion
        (some page.responseContinue)
        (next :: rest)

def kubernetesTargetPresent
    (namespaceName targetName : String)
    (pages : List KubernetesListPage) : Bool :=
  pages.any (fun page =>
    page.members.any (fun member =>
      member.namespaceName == namespaceName &&
      member.name == targetName))

def classifyKubernetesList
    (coordinate : Coordinate)
    (snapshotResourceVersion : String)
    (pages : List KubernetesListPage) : KubernetesListState :=
  match coordinate with
  | .kubernetesConfigMap authorityId namespaceName targetName =>
      if snapshotResourceVersion.isEmpty then
        .indeterminate
      else if !validKubernetesPages authorityId namespaceName snapshotResourceVersion none pages then
        .indeterminate
      else if kubernetesTargetPresent namespaceName targetName pages then
        .present
      else
        .absent
  | _ => .indeterminate

def kubernetesAbsenceAuthoritative (coordinate : Coordinate) (evidence : AbsenceEvidence) : Bool :=
  match coordinate, evidence with
  | .kubernetesConfigMap authorityId namespaceName targetName,
    .kubernetesCompleteList
      evidenceAuthorityId
      evidenceNamespace
      evidenceTargetName
      snapshotResourceVersion
      pages =>
      evidenceAuthorityId == authorityId &&
      evidenceNamespace == namespaceName &&
      evidenceTargetName == targetName &&
      classifyKubernetesList coordinate snapshotResourceVersion pages == .absent
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
