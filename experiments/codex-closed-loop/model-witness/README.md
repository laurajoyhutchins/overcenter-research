# Stage 1 uncertain-reasoning witness

This directory retains the exact input/output evidence from the first Stage 1 uncertain-reasoning pass.

The reasoning provider was Codex Cloud through the GitHub connector. The request explicitly prohibited repository/provider mutation and requested candidate JSON only. The branch head remained `c448001cbad04c502b21fee6e52a961b5d326801` across the request/response interval.

The raw response is not trusted. `candidate.json` is the exact JSON object extracted from that response. The sandbox runner validates its schema, exact allowed paths, content bounds, provenance digest, and unchanged branch-head evidence before applying it to a disposable synthetic workspace. Trusted verification and Overcenter settlement happen afterward.

This witness supports the bounded claim that an uncertain reasoning worker produced a useful candidate that the existing Stage 1 sandbox independently accepted. It does **not** prove that Codex Cloud lacked provider-side repository capability, so it remains ineligible for promotion.
