# Provider capability confinement

## Question

Can an untrusted reasoning worker participate in an effectful task without
possessing provider mutation credentials or choosing the provider mutation?

For the hosted GitHub commit-status path, the repaired boundary is:

```text
trusted authority
  define obligation
    + explicit effect contract
    + pinned adapter contract digest
    + deterministic result acceptance
  claim run
  bind TaskSession(g1)
        │
        ├── trusted session artifact ─────────────┐
        │                                         │
        ▼                                         │
untrusted worker                                  │
  contents: read                                  │
  statuses: none                                  │
  direct provider writes -> HTTP 403              │
  emit result data                                │
        │                                         │
        └── untrusted result artifact ───────┐     │
                                             ▼     ▼
                                         trusted broker
                                           verify result
                                           commit realization
                                           fence original session
                                           derive explicit effect
                                           reserve exact identity
                                           execute once
                                                 │
                                                 ▼
                                               GitHub
```

The session is bound before worker execution. The worker result does not carry
authority, and no worker `effect-ready` assertion exists.

## Explicit mutation authority

A verifier/postcondition describes what authoritative observation means. It does
not grant permission to make that state true.

An effectful obligation separately carries:

```text
effect contract
+ pinned adapter-contract digest
```

For the demonstrated path the contract is
`github-commit-status/set-from-postcondition/v1`. The adapter derives the
repository, SHA, context, and desired state from the authoritative postcondition,
so those coordinates are not duplicated.

An otherwise identical GitHub-status obligation without an effect grant remains
observation-only.

## Accepted realization

When `result_acceptance` is present, the broker cannot reserve an effect until
the kernel has committed an accepted-realization fact bound to the original run,
revision, execution generation, and authority commit.

A stale dispatch session cannot accept a result after authority rotates.

## Replay

The reservation records the exact effect contract, pinned adapter digest,
canonical effect digest, and accepted realization identity. A fresh execution
generation cannot create another reservation while the first remains unresolved.

Recovery independently observes provider truth and settles without replay.

## Boundary

GitHub still gives the trusted broker repository-scoped `statuses: write`.
Provider-native coordinate-scoped IAM is not claimed. The security property is
credential isolation plus a single supported broker/adapter mutation path.
