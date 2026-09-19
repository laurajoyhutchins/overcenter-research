scenario "only the newest execution generation can reserve an effect" do
  obligation :effect, content: "done"

  claim :effect, as: :generation_1
  renew_execution :generation_1, as: :generation_2
  renew_execution :generation_2, as: :generation_3

  reserve_effect :generation_1, as: :generation_1_attempt
  reserve_effect :generation_2, as: :generation_2_attempt
  reserve_effect :generation_3, as: :generation_3_attempt

  expect_error :generation_1_attempt, "STALE_EXECUTION_GENERATION"
  expect_error :generation_2_attempt, "STALE_EXECUTION_GENERATION"
  expect_success :generation_3_attempt
end
