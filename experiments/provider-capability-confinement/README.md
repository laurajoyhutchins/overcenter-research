> **Graduated by PR #81.** The experiment justified a smaller production boundary: the worker emits only an `effect-ready` signal, while the trusted side binds the task session, checks generation, and derives the provider effect from authority. The richer experiment request object below is retained as evidence, not as the current production interface.

# Provider capability confinement

## Question

Can the real execution substrate enforce the capability structure suggested by the Pulse experiment?

The claim is intentionally narrower than provider-native least privilege.

GitHub gives the trusted broker repository-scoped `statuses: write`; it does not issue a credential restricted to one SHA/context coordinate.

What Overcenter can prove is:

> The reasoning worker physically lacks provider mutation authority. A separate trusted broker holds the broad provider credential, re-derives the exact authorized effect from project authority, rejects worker-controlled drift before reservation, and cannot replay an unresolved effect through the kernel.

## Boundary

```text
reasoning worker
  contents: read
  statuses: none
       │
       │ candidate request bytes
       ▼
trusted broker
  contents: write
  statuses: write
       │
       ├── re-read authoritative work
       ├── re-derive exact effect request
       ├── reject any byte-level semantic drift
       ├── reserve effect durably
       └── execute authority-derived effect
                 │
                 ▼
              GitHub
```

The broker never constructs the provider mutation from worker JSON. Even a valid request merely authorizes crossing the boundary; provider inputs come from the authoritative obligation.

## Hostile cases

The untrusted worker emits:

- one valid request;
- wrong obligation;
- wrong run;
- wrong claimed revision;
- wrong repository identity;
- wrong commit;
- wrong context;
- wrong desired state;
- wrong operation kind;
- extra smuggled field.

The worker also attempts direct GitHub status mutations with its own job token. They must return HTTP 403.

The broker must reject every forged request **before acquiring execution authority or reserving an effect**.

After executing the one valid request, a fresh execution generation attempts the same effect again. The kernel must reject replay with `UNRESOLVED_EFFECT` before the provider callback is entered.

Recovery then proves exactly one authorized provider status exists and settles from canonical readback.

## What success does not mean

This does not make GitHub's credential itself coordinate-scoped. The broker remains trusted and its provider credential is broader than the task.

The result instead proves a physically separated reference architecture:

```text
untrusted reasoning
      ≠
provider mutation credential

worker request bytes
      ≠
provider command

authoritative task capability
      +
trusted broker
      =
one admissible provider mutation
```

A task-specific Rust executable could package this interface nicely, but it would not strengthen the security claim by itself. A hostile worker can bypass or modify local software; broker-side authority derivation is the actual boundary.
