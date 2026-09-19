scenario "changing consumed semantic content invalidates the downstream realization" do
  obligation :producer, content: "v1"
  obligation :consumer,
    content: "consumer-output",
    dependencies: [semantic(:producer)]

  settle :producer
  settle :consumer
  checkpoint :before_change

  amend :producer, content: "v2"
  settle :producer
  checkpoint :after_change

  expect_status :before_change, :consumer, "DONE"
  expect_status :after_change, :consumer, "READY"
  expect_no_run :after_change, :consumer
end
