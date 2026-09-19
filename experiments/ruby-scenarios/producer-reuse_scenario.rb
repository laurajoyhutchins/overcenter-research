scenario "equivalent semantic producer preserves an existing realization" do
  obligation :producer_a, content: "same-content"
  obligation :producer_c, content: "same-content"
  obligation :consumer,
    content: "consumer-output",
    dependencies: [semantic(:producer_a)]

  settle :producer_a
  settle :producer_c
  settle :consumer
  checkpoint :before_rewire

  amend :consumer,
    content: "consumer-output",
    dependencies: [semantic(:producer_c)]
  checkpoint :after_rewire

  expect_status :after_rewire, :consumer, "DONE"
  expect_same_run :consumer, before: :before_rewire, after: :after_rewire
end
