# Data contracts

Overcenter keeps durable and cross-language data boundaries under `contracts/`.

The format is inspired by ODCS: each contract has explicit identity, version, lifecycle, schema, compatibility, participants, quality evidence, and authoritative-definition references. Overcenter adds semantic-identity and authority metadata because safe replay, reuse, recovery, and settlement depend on more than structural validity.

## Contract package

A mature contract directory should contain:

```text
contract.json            contract metadata and semantic roles
schema.json              machine-readable wire/data structure
*-conformance.json       positive and hostile examples when useful
README.md                trust-boundary and semantic explanation
```

The package is intentionally dependency-light. A new framework is not required merely to declare a contract.

## Authority rules

1. Mechanically knowable structure belongs in `schema.json`, including declared `x-overcenter-*` validation annotations.
2. Contract metadata must state which fields are identity-bearing, result-bearing, diagnostic, or otherwise non-authoritative.
3. Free-form extension data must be explicitly quarantined; inheriting arbitrary `Record<string, unknown>` is not a compatibility strategy.
4. Implementations are consumers of the contract. TypeScript, Go, storage schemas, generated code, and prose do not become authoritative merely because they were written first.
5. Incompatible structural or semantic-identity changes require a new wire/data discriminator.
6. Conformance must be executable. Checked-in examples and cross-implementation tests are evidence, not decoration.
7. Generated output is not verified output. A generator can reduce duplication, but compatibility and semantic closure still require tests.


## Persisted discriminator names

Persisted discriminators are historical API identifiers. Do not rename one merely because an implementation backend changed. A legacy backend name can be documented as historical; changing durable identity for cosmetic consistency is worse than carrying the fossil.

## Migration order

Start with boundaries where disagreement is expensive:

1. computation execution and attempt evidence;
2. durable authority facts: obligation, claim, execution authority, effect reservation, receipt;
3. provider observations and absence evidence;
4. application-defined packets and other intentionally extensible payloads.

Do not migrate a type solely to increase schema coverage. The contract should remove ambiguity or duplicated semantic authority.
