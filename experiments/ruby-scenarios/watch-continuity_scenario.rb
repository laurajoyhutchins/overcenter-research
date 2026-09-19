scenario "WATCH continuity decides whether absence evidence survives" do
  provider :kubernetes_configmap, :kubernetes do
    continuity :broken, as: :broken_watch
    continuity :maintained, as: :continuous_watch
  end

  expect_evidence_preserved :broken_watch, false
  expect_evidence_preserved :continuous_watch, true
end
