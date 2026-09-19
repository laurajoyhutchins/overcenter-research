# ADR-0005: Preserve independent oracles when independence is evidence

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Overcenter uses experiments and differential implementations to falsify production assumptions. Some duplicated-looking code exists because an implementation that does not share the production path is useful evidence.

The [projection implementation comparison](../../experiments/projection-comparison/README.md) compared authoritative mutable SQLite lifecycle, the TypeScript projector, status-free SQL derivation, and Datalog derivation. The result supported derived projection while leaving TypeScript as the production implementation and Datalog as an independent executable oracle.

Other physical boundaries, such as the isolated Go computation executor, similarly benefit from independent validation rather than shared in-process helpers.

## Decision

Do not deduplicate an implementation merely because it resembles production code when its independence provides one of these functions:

- executable oracle;
- differential falsifier;
- reference/reconstruction backend;
- provider-specific semantic interpretation;
- physical trust or authority boundary.

Production semantic rules should have one owner once evidence establishes that owner, but independent evidence implementations may remain separate by design.

## Consequences

"DRY" is not an architectural objective by itself. A deduplication is accepted only when it reduces correctness-drift points without reducing experimental independence, authority separation, or hostile-case coverage.

For future deduplication work, the change should identify the duplicated semantic claim and cite the experiment or differential evidence establishing the production owner.

## Rejected alternatives

Sharing production helpers with Datalog/SQL/reference implementations solely to reduce line count was rejected because it would correlate failures and weaken differential evidence.

Keeping duplicate production semantics merely because experiments once had separate implementations was also rejected. Once a production owner is established, historical duplication must still earn its keep as evidence.

## Revisit when

Revisit a specific independent implementation when it no longer participates in a meaningful proof, differential check, reference reconstruction path, or trust boundary.
