# ADR-0003: Centralize GitHub object identity grammar

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Certified GitHub ref observation, pull-request observation, and postcondition validation independently recognized GitHub object IDs and, in some paths, independently implemented case-insensitive comparison.

The [GitHub observation grammar experiment](../../experiments/github-observation-grammar/github-observation.test.ts) tests exact provider coordinates and revision identity across GitHub API shapes. The focused regressions in [`test/github-certified-ref.test.ts`](../../test/github-certified-ref.test.ts) and [`test/github-certified-pr.test.ts`](../../test/github-certified-pr.test.ts) exercise invalid revision input and stale/current identity behavior.

## Decision

The GitHub provider layer has one owner for object-ID syntax and equality:

- `isGithubObjectId()`
- `sameGithubObjectId()`

These functions are shared by GitHub postcondition validation and certified GitHub identity observers.

Provider/entity adapters continue to own what an ID means in context, including ref coordinates, pull-request fields, and stale/current decisions.

## Consequences

GitHub identity syntax cannot silently drift between provider consumers.

This sharing is confined to the trusted TypeScript GitHub provider layer. It does not imply that validation across a physical trust boundary, such as the TypeScript-to-Go computation boundary, should be deduplicated.

## Rejected alternatives

Repeated regular expressions and comparison rules were rejected because they express one provider contract.

A generic cross-provider "object ID" abstraction was rejected because GitHub identity grammar is provider-specific and there is no evidence that other providers share it.

## Revisit when

Revisit if GitHub changes the accepted identity grammar or if a second provider demonstrates a genuinely common identity contract worth extracting.
