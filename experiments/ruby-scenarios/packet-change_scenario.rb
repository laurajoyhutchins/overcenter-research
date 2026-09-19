scenario "changing material packet input invalidates an otherwise identical realization" do
  obligation :artifact,
    content: "same-bytes",
    packet: {producer: "v1"}

  settle :artifact
  checkpoint :before_packet_change

  amend :artifact,
    content: "same-bytes",
    packet: {producer: "v2"}
  checkpoint :after_packet_change

  expect_status :before_packet_change, :artifact, "DONE"
  expect_status :after_packet_change, :artifact, "READY"
  expect_no_run :after_packet_change, :artifact
end
