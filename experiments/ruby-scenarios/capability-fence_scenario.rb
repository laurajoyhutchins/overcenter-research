scenario "stale execution capability fails before effect reservation" do
  obligation :effect, content: "done"

  claim :effect, as: :generation_1
  renew_execution :generation_1, as: :generation_2

  reserve_effect :generation_1, as: :stale_reservation
  expect_error :stale_reservation, "STALE_EXECUTION_GENERATION"

  reserve_effect :generation_2, as: :current_reservation
  expect_success :current_reservation
end
