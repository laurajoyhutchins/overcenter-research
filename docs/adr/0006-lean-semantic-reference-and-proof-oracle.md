# ADR-0006: Use Lean as an executable semantic reference and proof oracle

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

ADR-0005 preserves independent oracles when their independence is evidence. The
Lean work established a more specific boundary.

The claim-admission experiments showed that Lean can state useful independent
properties, prove graph-safety results, and execute the bounded semantic kernel
fast enough. The current-main authority-deletion experiment then tested the
obvious runtime integration against exact historical replay.

For 100 obligation-definition prefixes, current TypeScript graph validation took
about 14.5 ms. Launching a fresh Lean process for every validation took about
3.7-3.8 seconds. A persistent Lean process took about 79-82 ms, showing that the
semantic computation was not the problem; the proposed runtime seam was.

Invoking Lean only for new-work admission would also leave TypeScript deciding
graph truth during historical replay, creating two runtime authorities rather
than deleting one.

## Decision

Lean is an **executable semantic reference and proof oracle**, not a production
control-plane runtime dependency.

For selected deterministic safety predicates:

- Lean may define an independent proposition and proved executable reference;
- production TypeScript may use an operationally simpler implementation;
- CI feeds the same normalized facts to both and fails on bounded disagreement;
- a semantic change must either continue agreeing with the pinned oracle or
  deliberately amend the semantic specification, proof obligations, and pinned
  oracle identity.

The first maintained oracle covers provider-independent graph validity and
effect ordering over already-normalized effect facts. It exercises both control
and semantic dependency edges. For effect ordering, TypeScript is compared to
the retained Lean reference relation; the optimized Lean classifier must also
agree with that reference.

Provider-specific interpretation remains ordinary adapter software. In
particular, TypeScript owns GitHub effect-coordinate normalization; Lean receives
the normalized resource, desired state, commutativity, obligation IDs, and
dependency edges.

No production replay, admission, projection, settlement, or execution path
depends on a live Lean process.

## Consequences

Lean gets a durable role without adding daemon lifecycle, subprocess startup,
runtime availability, or deployment failure modes to the control plane.

Production implementations can be optimized or replaced while an independent
semantic reference remains available to detect drift.

Oracle agreement is a separate evidence class. A green bounded differential does
not turn a bounded result into a universal proof, and it does not prove
provider-specific normalization that occurs before the Lean boundary.

The current oracle is source-scoped rather than attached to every repository
change because installing/building Lean is materially heavier than normal unit
regression. Any change under `src/**` reruns it so a future helper extraction
cannot silently escape the oracle through a stale path allowlist.

## Rejected alternatives

**One Lean process per runtime decision** was rejected by the current-main replay
experiment. It exceeded the precommitted replay-cost ceiling by several seconds.

**A persistent Lean sidecar** was not adopted. Its measured semantic performance
was plausible, but it would introduce lifecycle, restart, version-fencing, IPC,
and deployment machinery solely to replace a small synchronous TypeScript
decision.

**Lean only at admission** was rejected because replay would retain a separate
TypeScript graph authority.

## Revisit when

Revisit runtime promotion for a specific predicate only when an experiment shows
that the existing authority-bearing implementation can be deleted and that the
replacement makes the complete system smaller or stronger after accounting for
runtime lifecycle and recovery.

Passing semantic-oracle CI is not sufficient evidence for runtime promotion.

## Evidence

- PR #113 — proved and benchmarked indexed Lean claim admission.
- PR #115 — current-main authority-deletion experiment that rejected the
  per-validation subprocess seam.
- Lean semantic-oracle CI — bounded differential between current TypeScript and
  exact pinned Lean revision
  `0c5db60f2dc14af93f554fd9f870181261ce5f11`.
