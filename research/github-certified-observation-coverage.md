# GitHub certified observation coverage

The pinned GitHub OpenAPI schema contains **647 GET/HEAD operations** in total, of which **271** are repository-scoped under `/repos/{owner}/{repo}`.

For the repository-observation question, the repository-scoped denominator is the useful one:

- original runtime surface: 4 / 271 = **1.48%**;
- first expansion: 17 / 271 = **6.27%**;
- current surface: 42 / 271 = **15.50%**;
- increase from the original runtime surface: **10.5×** by simple operation count;
- increase from the previous 17-operation surface: **2.47×**.

For completeness, against the entire GitHub GET/HEAD catalog including non-repository surfaces, coverage moves from 4 / 647 = **0.62%** originally to 42 / 647 = **6.49%** now.

The 42 registered operations cover repository/ref/commit/branch/tag identity; pull requests, files, reviews, review comments, issues, issue comments, and issue events; checks and commit statuses; Actions workflows, runs, jobs, and artifacts; releases/assets; deployments/statuses; Git trees/blobs; and commit-to-pull-request association.

These percentages are deliberately crude. Every endpoint counts equally; this is not a capability-weighted score. The expansion is therefore biased toward operations that remove real observation blind spots for autonomous repository work rather than toward cheap catalog inflation.

## Certified-readable means

1. Request grammar comes from the pinned GitHub OpenAPI operation.
2. Stable numeric repository identity is re-established before the target read.
3. A deliberately small response slice is structurally validated against the pinned response schema.
4. Evidence binds operation, request parameters, schema identity, observer identity, and observation time.
5. Generic reads are positive-only.

A 404, empty collection, transport failure, or schema mismatch remains **indeterminate**. None of those become authoritative absence.

The generic reader exists so adding the next endpoint is mostly a semantic decision: choose the exact coordinate and the response fields that carry durable meaning. It is not an invitation to register all 271 repository reads mechanically.

## Why these 25 next operations

The second expansion concentrates on repository state agents routinely need before making a judgment:

- review context: PR files, reviews, review comments, issue comments, and issue events;
- work discovery: repository PRs/issues, commits, branches, and tags;
- execution evidence: check-run/check-suite collections plus Actions workflow/run/job/artifact collections;
- immutable content identity: Git commits, trees, and blobs;
- delivery state: releases, deployments, deployment statuses, and commit-to-PR association.

That is a materially different goal from exposing all GitHub reads. Mutation remains outside this generic reader, and stronger semantics such as authoritative absence still require a dedicated verifier.
