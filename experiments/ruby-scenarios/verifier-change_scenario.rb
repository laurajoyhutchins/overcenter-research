scenario "changing the verifier contract invalidates prior realization reuse" do
  obligation :artifact,
    content: "same-bytes",
    consistency: :strong

  settle :artifact
  checkpoint :before_verifier_change

  amend :artifact,
    content: "same-bytes",
    consistency: :eventual
  checkpoint :after_verifier_change

  expect_status :before_verifier_change, :artifact, "DONE"
  expect_status :after_verifier_change, :artifact, "READY"
  expect_no_run :after_verifier_change, :artifact
end
