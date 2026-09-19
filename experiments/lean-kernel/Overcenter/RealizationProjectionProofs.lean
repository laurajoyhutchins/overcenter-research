import Overcenter.RealizationProjection

namespace Overcenter

theorem mutable_done_requires_fresh_verification
    (input : RealizationProjectionInput)
    (mutable :
      realizationStability input.postcondition.family = .mutableExternal)
    (done :
      (projectCurrentRealization input).lifecycle = .done) :
    ∃ observation,
      input.freshObservation = some observation ∧
      settle input.postcondition observation = .done := by
  cases active : latestNonterminalRun input.runs with
  | some run =>
      cases key : input.currentKey with
      | none =>
          simp [projectCurrentRealization, active, key] at done
      | some currentKey =>
          by_cases same : run.obligationKey == currentKey
          · cases status : run.status <;>
              simp [
                projectCurrentRealization,
                active,
                key,
                same,
                currentFromExecution,
                status
              ] at done
          · simp [projectCurrentRealization, active, key, same] at done
  | none =>
      cases key : input.currentKey with
      | none =>
          simp [projectCurrentRealization, active, key] at done
      | some currentKey =>
          cases historical : latestMatchingDoneRun currentKey input.runs with
          | some run =>
              cases fresh : input.freshObservation with
              | none =>
                  simp [
                    projectCurrentRealization,
                    active,
                    key,
                    historical,
                    revalidateHistoricalDone,
                    mutable,
                    fresh
                  ] at done
              | some observation =>
                  cases disposition : settle input.postcondition observation with
                  | done =>
                      exact ⟨observation, rfl, disposition⟩
                  | ready =>
                      simp [
                        projectCurrentRealization,
                        active,
                        key,
                        historical,
                        revalidateHistoricalDone,
                        mutable,
                        fresh,
                        disposition
                      ] at done
                  | recoveryRequired =>
                      simp [
                        projectCurrentRealization,
                        active,
                        key,
                        historical,
                        revalidateHistoricalDone,
                        mutable,
                        fresh,
                        disposition
                      ] at done
          | none =>
              cases fresh : input.freshObservation with
              | none =>
                  simp [
                    projectCurrentRealization,
                    active,
                    key,
                    historical,
                    producerIndependentFresh,
                    fresh
                  ] at done
              | some observation =>
                  cases disposition : settle input.postcondition observation with
                  | done =>
                      exact ⟨observation, rfl, disposition⟩
                  | ready =>
                      simp [
                        projectCurrentRealization,
                        active,
                        key,
                        historical,
                        producerIndependentFresh,
                        fresh,
                        disposition
                      ] at done
                  | recoveryRequired =>
                      simp [
                        projectCurrentRealization,
                        active,
                        key,
                        historical,
                        producerIndependentFresh,
                        fresh,
                        disposition
                      ] at done

theorem mutable_without_fresh_observation_never_projects_done
    (input : RealizationProjectionInput)
    (mutable :
      realizationStability input.postcondition.family = .mutableExternal)
    (missing : input.freshObservation = none) :
    (projectCurrentRealization input).lifecycle ≠ .done := by
  intro done
  obtain ⟨observation, fresh, _⟩ :=
    mutable_done_requires_fresh_verification input mutable done
  rw [missing] at fresh
  contradiction

private def filePostcondition : Postcondition := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque "/provider/a"
  expected := "sha256:a"
}

private def exactObservation : Observation := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque "/provider/a"
  certainty := .present
  actual := some "sha256:a"
}

private def uncertainObservation : Observation := {
  exactObservation with
  certainty := .uncertain
  actual := none
}

private def absentObservation : Observation := {
  family := .fileContent
  verifierRevision := "file-content-equals/v1@semantics-1"
  coordinate := .opaque "/provider/a"
  certainty := .absent
  actual := none
  absence := some (.localFileEnoent
    "/provider/a"
    "/provider/a"
    true
    "direct-coordinate-read"
    "ENOENT"
    "node:fs"
    "readFileSync"
    "ENOENT")
}

private def historicalDone : RealizationRun := {
  runId := "run-a"
  obligationKey := "key-a"
  status := .done
}

private def historicalExecuting : RealizationRun := {
  runId := "run-active"
  obligationKey := "key-a"
  status := .executing
}

private def mutableBase : RealizationProjectionInput := {
  postcondition := filePostcondition
  currentKey := some "key-a"
  runs := [historicalDone]
}

-- Historical mutable DONE requires current truth.
example :
    (projectCurrentRealization mutableBase).lifecycle = .recoveryRequired := by decide

example :
    (projectCurrentRealization {
      mutableBase with freshObservation := some exactObservation
    }).lifecycle = .done := by decide

example :
    (projectCurrentRealization {
      mutableBase with freshObservation := some uncertainObservation
    }).lifecycle = .recoveryRequired := by decide

example :
    (projectCurrentRealization {
      mutableBase with freshObservation := some absentObservation
    }).lifecycle = .unrealized := by decide

-- Current verified reality may satisfy an obligation with no producer run.
example :
    projectCurrentRealization {
      postcondition := filePostcondition
      currentKey := some "key-a"
      runs := []
      freshObservation := some exactObservation
    } = {
      lifecycle := .done
      sourceRunId := none
    } := by decide

-- Uncertainty with no known prior realization does not invent a recovery run.
example :
    (projectCurrentRealization {
      postcondition := filePostcondition
      currentKey := some "key-a"
      runs := []
      freshObservation := some uncertainObservation
    }).lifecycle = .unrealized := by decide

-- A stale active execution cannot disappear into a new executable obligation.
example :
    projectCurrentRealization {
      postcondition := filePostcondition
      currentKey := some "key-b"
      runs := [historicalExecuting]
      freshObservation := some exactObservation
    } = {
      lifecycle := .recoveryRequired
      sourceRunId := some "run-active"
    } := by decide

-- An unresolved current semantic key cannot erase active execution.
example :
    projectCurrentRealization {
      postcondition := filePostcondition
      currentKey := none
      runs := [historicalExecuting]
      freshObservation := none
    } = {
      lifecycle := .recoveryRequired
      sourceRunId := some "run-active"
    } := by decide

private def immutablePostcondition : Postcondition := {
  family := .immutableArtifact
  verifierRevision := "content-digest/v1@semantics-1"
  coordinate := .opaque "sha256:artifact-a"
  expected := "sha256:artifact-a"
}

example :
    (projectCurrentRealization {
      postcondition := immutablePostcondition
      currentKey := some "key-a"
      runs := [historicalDone]
    }).lifecycle = .done := by decide

end Overcenter
