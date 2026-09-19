scenario "recovery-required state survives destruction of the worker and local projection" do
  provider :eventually_consistent_file, :resource, expected: "created" do
    write_accepted
    worker_dies
  end

  checkpoint :owner
  reconstruct :fresh_clone

  expect_status :owner, :resource, "RECOVERY_REQUIRED"
  expect_status :fresh_clone, :resource, "RECOVERY_REQUIRED"
  expect_same_projection left: :owner, right: :fresh_clone
  expect_effect_attempts :resource, 1
end
