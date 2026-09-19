# Security

Overcenter deliberately works near authority boundaries: execution fencing, recovery after uncertain effects, provider mutation, credential separation, process isolation, and evidence used to justify project truth.

Security reports that could allow an untrusted worker to cross one of those boundaries are especially valuable.

## Reporting a vulnerability

Please avoid publishing working exploit details, credentials, or secrets in a new public issue.

If GitHub private vulnerability reporting is available for this repository, use the repository's **Security** tab to submit the report privately. Otherwise, contact the repository owner through their GitHub profile before sharing exploit details publicly.

A useful report includes:

- the exact revision tested;
- the authority boundary you expected to hold;
- the smallest reproducer;
- whether the behavior can mutate authoritative state or only local/ephemeral state;
- whether the outcome may already have mutated even when acknowledgement is missing;
- any evidence needed to distinguish a safe failure from an ambiguous one.

## High-value classes of report

Examples include:

- stale execution authority accepted after generation or revision changes;
- a worker manufacturing `DONE` or equivalent project truth without valid settlement evidence;
- replay of an effect whose prior outcome is uncertain;
- provider credentials crossing into an untrusted task;
- task-controlled bytes escaping the authorized filesystem or process boundary;
- identity mismatches between authorized bytes and executed/observed bytes;
- cross-run or cross-obligation evidence reuse;
- mutation occurring before its durable reservation or authority check;
- a proof or verifier accepting evidence for a different exact coordinate than the one settled.

## Scope of the current claim

This repository is a research codebase with a narrow supported runtime slice, not a hardened multi-tenant service.

A security result is still useful when it breaks only an experimental claim. Please identify whether the affected path is part of the supported runtime, a reference backend, an experiment, or a formal model.

The safest interpretation of ambiguous mutation is fail-closed: if a report demonstrates that an effect may have happened, recovery should reconcile authoritative reality before allowing repetition.
