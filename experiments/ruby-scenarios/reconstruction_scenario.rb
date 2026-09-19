scenario "a fresh authority clone reconstructs the exact project projection" do
  obligation :publish, content: "artifact"
  obligation :verify,
    content: "verified",
    dependencies: [control(:publish)]

  settle :publish
  checkpoint :owner
  reconstruct :fresh_clone

  expect_status :owner, :publish, "DONE"
  expect_status :owner, :verify, "READY"
  expect_same_projection left: :owner, right: :fresh_clone
end
