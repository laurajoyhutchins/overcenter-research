# Effect-authority red-team regression guards

PR #96 reproduced four authority failures in the first `effect-ready` design.
This directory now keeps those attacks as regression tests for the repair.

## Repaired boundary

```text
trusted dispatch
   ├── immutable TaskSession(gN)
   ├── explicit versioned effect authority
   └── deterministic result-acceptance contract
                 │
                 ▼
          untrusted worker
                 │
            result data
                 ▼
      deterministic acceptance
                 │
       durable realization fact
                 ▼
          trusted broker
   ├── original TaskSession(gN)
   ├── current-authority fence
   ├── pinned adapter contract
   ├── exact effect digest
   ├── exact realization identity
   └── durable reservation
                 │
                 ▼
              provider
```

## Regression 1: late session rebinding

The TaskSession is minted by trusted dispatch before the worker starts. The
worker result envelope carries that exact session identity. If execution
authority rotates before the result is accepted, the original session is stale;
if a broker reconstructs a newer session, the old result fails with a session
mismatch instead of inheriting the newer authority.

## Regression 2: observation is not mutation authority

A GitHub status postcondition with no `effect_authority` is observation-only.
The provider adapter cannot derive or execute a mutation from it.

The effect grant stores both a versioned effect contract and the exact adapter
contract digest. An adapter-contract change therefore cannot silently reinterpret
an existing obligation.

## Regression 3: worker readiness is not authoritative

`effect-ready` no longer exists in the production path. The worker emits a
result envelope. The kernel verifies it against the obligation's deterministic
acceptance contract and commits an accepted-realization fact.

The broker fails with `REALIZATION_REQUIRED` if an obligation requires a
realization and none has been accepted.

## Regression 4: no generic arbitrary effect callback

`runGitCoreLoop(kernel,{effect})` is no longer exported. There is no generic
production API that takes `work.packet` and calls an arbitrary effect callback.

Provider effects pass through explicit effect authority, the trusted broker, a
durable exact-effect reservation, and the provider adapter.

## Exact reservation identity

A v2 effect reservation binds:

- run and obligation;
- execution generation and authority commit;
- effect-contract identifier;
- pinned adapter-contract digest;
- canonical concrete-effect digest;
- accepted-realization commit and result digest, when required.

Replay independently derives the pinned effect identity from the obligation and
rejects histories whose reservation identity does not match.
