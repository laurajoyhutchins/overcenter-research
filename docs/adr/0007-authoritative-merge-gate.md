# ADR-0007: Require one authoritative merge gate over core evidence

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Overcenter already produces substantial CI evidence: deterministic regression, adversarial proofs, TLA+ safety checks, the isolated Go computation boundary, and self-application against an exact source revision.

Those checks previously ran as separate top-level workflows. GitHub could display them, but there was no single status whose meaning was "the core evidence required to admit this revision has succeeded." The default branch was also not protected by repository policy.

Independent experimental workflows remain valuable evidence, but repository admission should not require a human or an agent to reconstruct project truth from a collection of loosely related green badges.

## Decision

Define one GitHub Actions workflow, **Merge gate**, as the composition point for core merge evidence.

The gate calls three reusable evidence producers:

1. `Evidence` for deterministic regression, adversarial local proofs, and TLA+ safety;
2. `Production computation executor` for the exact-byte Go computation boundary;
3. `Overcenter self-application` for deterministic self-verification.

All three required producers explicitly check out the same source revision:

```text
pull request -> github.event.pull_request.head.sha
push/manual  -> github.sha
```

The final `Merge gate` job succeeds only when all three producers succeed for that revision.

GitHub repository policy should require the single final `Merge gate` status on `main` and require pull requests to be current with the target branch before merge. Specialized experiment and provider workflows remain supplemental evidence unless a later ADR explicitly promotes them into the core gate.

## Consequences

The repository has one mechanically checkable merge predicate instead of an informal interpretation of many workflow results.

Core evidence producers remain independently invokable through `workflow_dispatch`, but their ordinary pull-request and `main` triggers move into the merge-gate composition so they are not duplicated.

The computation proof now runs for every candidate merge rather than only path-selected changes. This is intentionally conservative while the required evidence set is small. A later optimization may introduce deterministic affected-evidence selection, but selection must itself be software-defined and fail closed.

The gate proves evidence for an exact source revision. Repository policy is still responsible for preventing a stale pull-request head from being admitted after the target branch advances.

## Rejected alternatives

Requiring every existing workflow directly in branch protection was rejected because the set includes experimental and path-scoped checks whose presence varies by change. That would make repository admission depend on workflow topology rather than one stable semantic predicate.

A polling workflow that queries GitHub for other check-run names was rejected because it would turn external UI/status naming into merge semantics and introduce timing races.

Duplicating all proof commands directly inside one monolithic workflow was rejected because the existing evidence workflows are useful independently and should remain named, executable units.

## Revisit when

Revisit this decision when core evidence becomes expensive enough that every candidate merge cannot reasonably run the full set, or when Overcenter itself can authoritatively evaluate a machine-readable evidence manifest and project the resulting admission decision back to GitHub.
