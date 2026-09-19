# GitHub certified observation coverage

The pinned GitHub OpenAPI schema contains **647 GET/HEAD operations** in total, of which **271** are repository-scoped under `/repos/{owner}/{repo}`.

For the repository-observation question, the repository-scoped denominator is the useful one:

- before: 4 / 271 = **1.48%**;
- after: 17 / 271 = **6.27%**;
- increase: **4.25×** by simple operation count.

For completeness, against the entire GitHub GET/HEAD catalog including non-repository surfaces, coverage moves from 4 / 647 = **0.62%** to 17 / 647 = **2.63%**.

The registered surface now covers repository/ref/commit/branch identity, pull requests and issues, check runs and suites, commit statuses, Actions workflows/runs/jobs, releases/assets, and deployments/statuses.

These percentages are deliberately crude. Every endpoint counts equally; this is not a capability-weighted score.

## Certified-readable means

1. Request grammar comes from the pinned GitHub OpenAPI operation.
2. Stable numeric repository identity is re-established before the target read.
3. A deliberately small response slice is structurally validated against the pinned response schema.
4. Evidence binds operation, request parameters, schema identity, observer identity, and observation time.
5. Generic reads are positive-only.

A 404, empty collection, transport failure, or schema mismatch remains **indeterminate**. None of those become authoritative absence.

The generic reader exists so adding the next endpoint is mostly a semantic decision: choose the exact coordinate and the response fields that carry durable meaning. It is not an invitation to register all 271 repository reads mechanically.
