scenario "semantic dependency declaration order does not change realization identity" do
  obligation :alpha, content: "A"
  obligation :charlie, content: "C"
  obligation :consumer,
    content: "result",
    dependencies: [semantic(:alpha), semantic(:charlie)]

  settle :alpha
  settle :charlie
  settle :consumer
  checkpoint :before_reorder

  amend :consumer,
    content: "result",
    dependencies: [semantic(:charlie), semantic(:alpha)]
  checkpoint :after_reorder

  expect_status :after_reorder, :consumer, "DONE"
  expect_same_run :consumer, before: :before_reorder, after: :after_reorder
end
