# Architecture decision records

Architecture decisions live here. Research notes and experiments establish evidence; ADRs record the architectural choice made from that evidence.

Each ADR should answer five things:

1. What concrete decision did we make?
2. What evidence justified it?
3. What remains deliberately outside the decision?
4. What alternatives did we reject?
5. What would cause us to revisit it?

Use one ADR per decision. Do not accumulate unrelated decisions into a rolling architecture essay.

## Status vocabulary

- **Proposed** — under active evaluation.
- **Accepted** — current architectural policy.
- **Superseded** — replaced by a later ADR.
- **Rejected** — considered and deliberately not adopted.

## Decisions

| ADR | Status | Decision |
| --- | --- | --- |
| [ADR-0001](./0001-storage-neutral-kernel-loop.md) | Accepted | Keep one storage-neutral project-transition loop above durable fact-store adapters. |
| [ADR-0002](./0002-semantic-dependency-selector-grammar.md) | Accepted | Give semantic dependency selector grammar one owner while keeping admission and replay responsibilities separate. |
| [ADR-0003](./0003-github-object-identity.md) | Accepted | Give GitHub object-ID grammar and equality one provider-wide owner. |
| [ADR-0004](./0004-certified-github-read-plumbing.md) | Accepted | Share mechanical GitHub observation/certification plumbing without sharing provider meaning. |
| [ADR-0005](./0005-independent-oracles-remain-independent.md) | Accepted | Preserve independent experimental oracles and reference implementations when their independence is evidence. |
| [ADR-0006](./0006-lean-semantic-reference-and-proof-oracle.md) | Accepted | Use Lean as an executable semantic reference and proof oracle, not a production runtime dependency. |
| [ADR-0007](./0007-authoritative-merge-gate.md) | Accepted | Require one stable merge gate over the exact core evidence for a source revision. |
| [ADR-0008](./0008-rust-native-worker-confinement.md) | Accepted | Admit Rust only for a narrow native worker-confinement substrate; keep authority semantics in TypeScript. |
