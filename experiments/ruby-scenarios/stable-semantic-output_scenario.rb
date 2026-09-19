scenario "producer-local changes do not invalidate a consumer of unchanged verified output" do
  obligation :producer,
    content: "stable-output",
    packet: {implementation: "v1"}
  obligation :consumer,
    content: "consumer-output",
    dependencies: [semantic(:producer)]

  settle :producer
  settle :consumer
  checkpoint :before_producer_change

  amend :producer,
    content: "stable-output",
    packet: {implementation: "v2"}
  settle :producer
  checkpoint :after_producer_change

  expect_status :after_producer_change, :consumer, "DONE"
  expect_same_run :consumer,
    before: :before_producer_change,
    after: :after_producer_change
end
