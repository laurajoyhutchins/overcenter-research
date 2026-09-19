# ADR-0002: Centralize semantic dependency selector grammar

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Admission and semantic identity both need to understand the supported semantic dependency selectors:

```text
output   / verified-content
evidence / settlement-receipt
```

Before this decision, each path independently encoded that vocabulary and the unsupported-selector rule.

The [bounded graph exhaustion experiment](../../experiments/bounded-graph-exhaustion/README.md) exhaustively exercises the supported typed dependency choices through the current graph bound and differentially checks production admission and semantic-key behavior. [`test/dependency-edge-adversarial.test.ts`](../../test/dependency-edge-adversarial.test.ts) additionally checks that unsupported selectors fail before definition authority changes.

## Decision

`semanticDependencySelection()` owns the legal selector vocabulary and the stable unsupported-selector error.

Admission and replay remain separate consumers:

```text
             semanticDependencySelection()
                    /             \
                   /               \
        admission checks        replay identity
        availability            historical meaning
```

Admission still owns pre-commit validation, including whether a selected output is available. Replay/identity still owns deriving the exact identity consumed by already-admitted history.

## Consequences

Adding or removing a selector requires changing one grammar owner plus the distinct admission/replay behavior that selector needs.

This is not a merger of admission and replay. Their different failure responsibilities remain visible and independently testable.

## Rejected alternatives

Duplicating the selector switch in both paths was rejected because the legal vocabulary is one semantic contract.

Collapsing admission and replay into one function was rejected because pre-admission rejection and historical reconstruction are different safety jobs.

## Revisit when

Revisit if a future selector cannot be represented by a stable shared grammar without weakening replay compatibility or admission-time fail-closed behavior.
