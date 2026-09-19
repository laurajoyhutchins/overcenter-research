scenario "rewiring a satisfied control edge does not poison realization identity" do
  obligation :gate_a, content: "A"
  obligation :gate_c, content: "C"
  obligation :work,
    content: "stable-output",
    dependencies: [control(:gate_a)]

  settle :gate_a
  settle :gate_c
  settle :work
  checkpoint :before_rewire

  amend :work,
    content: "stable-output",
    dependencies: [control(:gate_c)]
  checkpoint :after_rewire

  expect_status :after_rewire, :work, "DONE"
  expect_same_run :work, before: :before_rewire, after: :after_rewire
end
