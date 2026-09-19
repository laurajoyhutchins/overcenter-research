# Source layout

The source tree is organized by architectural authority, not by implementation accident.

```text
src/
├── authority/      authoritative project-state transitions and derived judgments
├── graph/          dependency topology and semantic identity
├── observation/    external-state observation and evidence interpretation
├── execution/      exact authorized computation and executor transport
├── storage/        durable fact-store implementations
├── providers/      provider-specific API and resource semantics
├── model.ts        shared public data model
├── semantics.ts    remaining cross-provider settlement/effect semantics
└── digest.ts       canonical hashing
```

## Boundary rule

Paths should answer what the code is allowed to decide.

- `authority/` may determine Overcenter project truth from admitted definitions and durable evidence.
- `graph/` describes topology and semantic identity; it does not settle work.
- `observation/` reports and interprets external state; it does not mutate project truth directly.
- `execution/` performs an already-authorized computation and returns attempt evidence; it does not decide eligibility or settlement.
- `storage/` persists durable facts; storage backends do not define authority policy.
- `providers/` contains provider-specific mechanics and semantics that must remain outside the provider-general authority core.

Root modules retained after this reorganization are compatibility re-exports unless they are genuinely cross-cutting modules such as `model.ts`, `semantics.ts`, and `digest.ts`. New production code should import the canonical namespaced paths.
