# Evidence and provenance

Overcenter keeps evidence that can justify project truth after disposable execution machinery disappears. It does not attempt to retain every operational event forever.

## Durable evidence versus telemetry

Durable evidence may include:

- immutable obligation identity and exact source/graph inputs;
- claims and execution-generation ancestry;
- unresolved effect reservations;
- canonical provider observations and absence certificates;
- verifier identity and exact verification result;
- settlement receipts and resulting authority identity;
- content-addressed evidence references when large bytes live outside the authority log.

Typical disposable telemetry includes scheduler wakes, heartbeats, repeated polling, local logs, caches, temporary workspaces, and duplicate transport responses unless one of those facts becomes material to a correctness proof.

The rule is:

    retain the proof needed to reconstruct the claim, not the exhaust of producing it

## Owners

- [`src/authority/facts.ts`](../src/authority/facts.ts) owns durable fact schemas.
- [`src/authority/replay.ts`](../src/authority/replay.ts) reconstructs historical project facts.
- [`src/authority/project-state.ts`](../src/authority/project-state.ts) derives the current projection.
- [`src/evidence/store.ts`](../src/evidence/store.ts) and [`src/evidence/reference.ts`](../src/evidence/reference.ts) own content-addressed evidence storage/reference boundaries.
- [`src/observation/evidence.ts`](../src/observation/evidence.ts) owns provider-general absence-certificate structure.
- [`contracts/`](../contracts/README.md) contains versioned cross-language durable data contracts.

## Evidence must bind meaning

A digest is useful only when its semantic coordinate is known. Correctness-critical evidence should identify enough context to answer:

- which obligation and exact revision does this prove?
- which provider/resource coordinate was observed?
- which verifier interpreted it?
- was a negative observation complete and authoritative?
- which authority accepted the settlement?

Worker-local names, mutable Git remotes, a bare HTTP status, or an unscoped hash are not substitutes for those bindings.

## Reconstructibility test

A useful durability test is to delete materialized projection/cache state and ask whether a fresh process can replay retained authority and recover the same justified terminal project state. If not, some correctness fact is living in disposable machinery.

## Generated output

Generated output is not verified output. A generator may create schema/code/evidence bytes, but the consumer still needs an independent check that those bytes satisfy the authoritative contract and exact identity expected by downstream settlement.
