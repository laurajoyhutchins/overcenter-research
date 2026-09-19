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
    (mutableExternal :
      realizationStability current.postcondition.family = .mutableExternal) :
    reusable current historical none = false := by
  simp [reusable, mutableExternal]

private def filePostcondition : Postcondition := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque "/provider/a"
  expected := "sha256:a"
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
  coordinate := .opaque "/provider/a"
  certainty := .present
  actual := some "sha256:a"
}

private def wrongCoordinateObservation : Observation := {
  exactObservation with
  coordinate := .opaque "/provider/b"
}

private def uncertainObservation : Observation := {
  exactObservation with
  certainty := .uncertain
}

private def localAbsence : AbsenceEvidence :=
  .localFileEnoent
    "/provider/a"
    "/provider/a"
    true
    "direct-coordinate-read"
    "ENOENT"
    "node:fs"
    "readFileSync"
    "ENOENT"

private def authoritativeAbsenceObservation : Observation := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque "/provider/a"
  certainty := .absent
  actual := none
  absence := some localAbsence
}

private def forgedAbsenceObservation : Observation := {
  authoritativeAbsenceObservation with
  absence := some (
    .localFileEnoent
      "/provider/a"
      "/provider/b"
      true
      "direct-coordinate-read"
      "ENOENT"
      "node:fs"
      "readFileSync"
      "ENOENT"
  )
}

private def wrongProvenanceObservation : Observation := {
  authoritativeAbsenceObservation with
  absence := some (
    .localFileEnoent
      "/provider/a"
      "/provider/a"
      true
      "direct-coordinate-read"
      "ENOENT"
      "node:fs"
      "existsSync"
      "ENOENT"
  )
}

private def mutableHistory : HistoricalRealization := {
  key := obligationKey fileObligation
  disposition := .done
}

private def immutablePostcondition : Postcondition := {
  family := .immutableArtifact
  verifierRevision := "content-digest/v1@semantics-1"
  coordinate := .opaque "sha256:artifact-a"
  expected := "sha256:artifact-a"
}

private def immutableObligation : Obligation := {
  id := "artifact-a"
  packetIdentity := "sha256:packet-a"
  postcondition := immutablePostcondition
  semanticInputs := ["sha256:source-a"]
}

private def immutableHistory : HistoricalRealization := {
  key := obligationKey immutableObligation
  disposition := .done
}

private def verifierChangedObligation : Obligation := {
  fileObligation with
  postcondition := {
    filePostcondition with
    verifierRevision := "file-content-equals/v1@semantics-2"
  }
}

private def kubePostcondition : Postcondition := {
  family := .kubernetesConfigMapExists
  verifierRevision := "kubernetes-configmap-exists/v1@semantics-1"
  coordinate := .kubernetesConfigMap "cluster-a" "proof" "missing"
  expected := "exists"
}

private def kubeMember : KubernetesListMember := {
  name := "other"
  namespace := "proof"
  uid := "uid-other"
  resourceVersion := "487"
}

private def kubePage1 : KubernetesListPage := {
  requestContinue := none
  responseContinue := "next"
  snapshotResourceVersion := "489"
  members := [kubeMember]
}

private def kubePage2 : KubernetesListPage := {
  requestContinue := some "next"
  responseContinue := ""
  snapshotResourceVersion := "489"
  members := []
}

private def kubeAbsence : AbsenceEvidence :=
  .kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [kubePage1, kubePage2]

private def kubeAbsentObservation : Observation := {
  family := .kubernetesConfigMapExists
  verifierRevision := "kubernetes-configmap-exists/v1@semantics-1"
  coordinate := .kubernetesConfigMap "cluster-a" "proof" "missing"
  certainty := .absent
  actual := none
  absence := some kubeAbsence
}

private def kubeTargetMember : KubernetesListMember := {
  name := "missing"
  namespace := "proof"
  uid := "uid-target"
  resourceVersion := "488"
}

private def kubeTargetHiddenOnLaterPage : Observation := {
  kubeAbsentObservation with
  absence := some (.kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [
      kubePage1,
      { kubePage2 with members := [kubeTargetMember] }
    ])
}

private def kubeBrokenContinuation : Observation := {
  kubeAbsentObservation with
  absence := some (.kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [
      kubePage1,
      { kubePage2 with requestContinue := some "wrong" }
    ])
}

private def kubeChangedSnapshot : Observation := {
  kubeAbsentObservation with
  absence := some (.kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [
      kubePage1,
      { kubePage2 with snapshotResourceVersion := "490" }
    ])
}

private def kubePartialPagination : Observation := {
  kubeAbsentObservation with
  absence := some (.kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [
      kubePage1
    ])
}

private def kubeWrongNamespaceMember : Observation := {
  kubeAbsentObservation with
  absence := some (.kubernetesCompleteList
    "cluster-a"
    "proof"
    "missing"
    "489"
    [
      { kubePage1 with members := [{ kubeMember with namespace := "other" }] },
      kubePage2
    ])
}

example : settle filePostcondition exactObservation = .done := by decide
example : settle filePostcondition wrongCoordinateObservation = .recoveryRequired := by decide
example : settle filePostcondition uncertainObservation = .recoveryRequired := by decide
example : settle filePostcondition authoritativeAbsenceObservation = .ready := by decide
example : settle filePostcondition forgedAbsenceObservation = .recoveryRequired := by decide
example : settle filePostcondition wrongProvenanceObservation = .recoveryRequired := by decide

-- Historical DONE is not enough for mutable provider state.
example : reusable fileObligation mutableHistory none = false := by decide
example : reusable fileObligation mutableHistory (some exactObservation) = true := by decide

-- Immutable realization reuse is policy derived from the verifier family, not trusted history.
example : realizationStability immutableObligation.postcondition.family = .immutable := by decide
example : reusable immutableObligation immutableHistory none = true := by decide

-- Changing verifier semantics invalidates both historical identity and fresh evidence.
example : obligationKey verifierChangedObligation ≠ obligationKey fileObligation := by decide
example : reusable verifierChangedObligation mutableHistory (some exactObservation) = false := by decide

-- Kubernetes complete LIST evidence derives its own completeness.
example : settle kubePostcondition kubeAbsentObservation = .ready := by decide
example : settle kubePostcondition kubeTargetHiddenOnLaterPage = .recoveryRequired := by decide
example : settle kubePostcondition kubeBrokenContinuation = .recoveryRequired := by decide
example : settle kubePostcondition kubeChangedSnapshot = .recoveryRequired := by decide
example : settle kubePostcondition kubePartialPagination = .recoveryRequired := by decide
example : settle kubePostcondition kubeWrongNamespaceMember = .recoveryRequired := by decide

end Overcenter
