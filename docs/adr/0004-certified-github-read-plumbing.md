# ADR-0004: Share GitHub certified-read plumbing, not GitHub meaning

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Repository, ref, pull-request, status, and generic positive-only GitHub reads all need the same mechanical path:

```text
materialized GET
      |
      v
provider transport
      |
      v
RawObservation
      |
      v
response-slice validation
      |
      v
structural certificate
```

The [provider observation reuse experiment](../../research/provider-observation-reuse.md) showed that GitHub and Kubernetes can share observation-envelope and structural-certification mechanics while keeping identity, completeness, freshness, and negative-evidence meaning provider-local. In that experiment, factoring the shared machinery materially reduced the second provider's structural/provenance implementation without introducing provider conditionals into the common layer.

## Decision

`observeCertifiedGithubRead200()` owns GitHub's mechanical positive-read certification path.

Both specialized GitHub observers and the broader positive-only `observeCertifiedGithubSemanticRead()` compose that helper.

The helper does not decide:

- repository identity semantics;
- ref canonicalization or stale/current meaning;
- pull-request identity semantics;
- collection completeness or pagination meaning;
- authoritative negative evidence.

Those remain in the relevant adapters.

## Consequences

There is one implementation of the transport-to-certificate mechanism and multiple small semantic consumers.

The generic reader cannot turn a 404, empty collection, transport failure, or schema failure into authoritative absence. The current certified-observation coverage remains documented in [`research/github-certified-observation-coverage.md`](../../research/github-certified-observation-coverage.md).

## Rejected alternatives

Keeping separate low-level certification paths for generic and specialized reads was rejected because they perform the same mechanical transformation.

Moving entity semantics into the shared helper was rejected because the provider-reuse experiment specifically supports sharing structural mechanics, not flattening provider meaning.

## Revisit when

Revisit if another GitHub read requires different certification mechanics, or if another provider experiment justifies a stronger provider-neutral abstraction.
