scenario "the same missing observation has provider-specific authority" do
  provider :github_status, :github do
    observe :missing, as: :github_missing
    observe :wrong_coordinate, as: :github_wrong_coordinate
    observe :present, as: :github_present
  end

  provider :kubernetes_configmap, :kubernetes do
    observe :missing, as: :kubernetes_missing
    observe :wrong_coordinate, as: :kubernetes_wrong_coordinate
    observe :continuation_expires, as: :kubernetes_expired
    observe :present, as: :kubernetes_present
  end

  expect_readback(
    :github_missing,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "COLLECTION_ABSENCE_NOT_AUTHORITATIVE",
    absence_evidence: nil
  )
  expect_readback(
    :github_wrong_coordinate,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "GITHUB_REPOSITORY_IDENTITY_MISMATCH",
    absence_evidence: nil
  )
  expect_readback(
    :github_present,
    disposition: "DONE",
    certainty: "present"
  )

  expect_readback(
    :kubernetes_missing,
    disposition: "READY",
    certainty: "absent"
  )
  expect_absence_kind(
    :kubernetes_missing,
    "kubernetes-complete-list-absence/v1"
  )
  expect_readback(
    :kubernetes_wrong_coordinate,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "KUBERNETES_LIST_OBSERVATION_COORDINATE_MISMATCH",
    absence_evidence: nil
  )
  expect_readback(
    :kubernetes_expired,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "KUBERNETES_CONTINUATION_EXPIRED",
    absence_evidence: nil
  )
  expect_readback(
    :kubernetes_present,
    disposition: "DONE",
    certainty: "present"
  )
end
