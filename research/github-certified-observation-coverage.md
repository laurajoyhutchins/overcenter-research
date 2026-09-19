# GitHub certified observation coverage

The pinned GitHub OpenAPI schema contains **647 GET/HEAD operations**.

Before this change, production pinned four schema-derived GitHub observation operations, or **0.62%** by simple operation count. This change pins **17**, or **2.63%**, a **4.25×** increase.

The registered surface now covers repository/ref/commit/branch identity, pull requests and issues, check runs and suites, commit statuses, Actions workflows/runs/jobs, releases/assets, and deployments/statuses.

This is not a capability-weighted score. Every endpoint counts equally.

## Certified-readable means

1. Request grammar comes from the pinned GitHub OpenAPI operation.
2. Stable numeric repository identity is re-established before the target read.
3. A deliberately small response slice is structurally validated against the pinned response schema.
4. Evidence binds operation, request parameters, schema identity, observer identity, and observation time.
5. Generic reads are positive-only.

A 404, empty collection, transport failure, or schema mismatch remains **indeterminate**. None of those become authoritative absence.

The generic reader exists so adding the next endpoint is mostly a semantic decision: choose the exact coordinate and the response fields that carry durable meaning. It is not an invitation to register all 647 mechanically.
