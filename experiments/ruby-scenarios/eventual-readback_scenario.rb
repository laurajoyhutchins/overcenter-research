scenario "uncertain provider readback never authorizes blind replay" do
  provider :eventually_consistent_file, :resource, expected: "created" do
    write_accepted
    worker_dies

    readback :missing, as: :missing
    readback "old-value", as: :stale
    readback :expected, as: :converged
  end

  expect_status :missing, :resource, "RECOVERY_REQUIRED"
  expect_status :stale, :resource, "RECOVERY_REQUIRED"
  expect_status :converged, :resource, "DONE"

  expect_readback(
    :missing,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "NEGATIVE_READ_NOT_AUTHORITATIVE",
    absence_evidence: nil
  )
  expect_readback(
    :stale,
    disposition: "RECOVERY_REQUIRED",
    certainty: "uncertain",
    error: "NON_MATCHING_READ_NOT_AUTHORITATIVE",
    absence_evidence: nil
  )
  expect_readback(
    :converged,
    disposition: "DONE",
    certainty: "present"
  )

  expect_effect_attempts :resource, 1
  expect_receipts(
    :resource,
    "RECOVERY_REQUIRED",
    "RECOVERY_REQUIRED",
    "RECOVERY_REQUIRED",
    "DONE"
  )
end
