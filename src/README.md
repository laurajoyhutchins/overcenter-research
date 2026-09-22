# Source layout

The source tree is organized by architectural authority, not by implementation accident.

```text
src/
├── authority/      project truth, admission, replay, recovery, and realization reuse
├── graph/          dependency topology and semantic identity
├── observation/    external-state observation and evidence interpretation
├── execution/      authorized computation, confinement, and executor transport
├── storage/        durable fact-store implementations
├── providers/      provider-specific API and resource semantics
├── generated/      checked generated runtime artifacts
├── model.ts        shared public data model
├── semantics.ts    cross-provider settlement and effect semantics
├── digest.ts       canonical hashing
├── structural-schema.ts
└── validation.ts   cross-cutting deterministic validation primitives
```

## Boundary rule

Paths should answer what the code is allowed to decide.

- `authority/` may determine Overcenter project truth from admitted definitions and durable evidence.
- `graph/` describes topology and semantic identity. It does not settle work.
- `observation/` reports and interprets external state. It does not mutate project truth directly.
- `execution/` performs already-authorized work and returns attempt evidence. It does not decide eligibility or settlement.
- `storage/` persists durable facts. Storage backends do not define authority policy.
- `providers/` contains provider-specific mechanics and semantics that stay outside the provider-general authority core.
- Root source files are reserved for genuinely cross-cutting primitives.

There are no compatibility barrels for the former flat `src/` layout. Callers import canonical paths directly, so stale paths fail during compilation or tests rather than being silently adapted.
