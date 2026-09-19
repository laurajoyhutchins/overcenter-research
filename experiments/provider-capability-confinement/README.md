# Provider capability confinement

## Question

Can the real execution substrate enforce the capability structure suggested by the Pulse experiment without asking the worker to restate provider authority?

The supported claim is narrower than provider-native least privilege. GitHub gives the trusted broker repository-scoped `statuses: write`; it does not issue a credential restricted to one SHA/context coordinate.

Overcenter instead uses this boundary:

```text
trusted scheduler / authority
        │
        ├── exact run
        ├── claimed revision
        └── worker generation
                 │
                 ▼
       server-side TaskSession

untrusted reasoning worker
  contents: read
  statuses: none
        │
        │  { schema, kind:"effect-ready" }
        ▼
trusted broker
        │
        ├── validate two-field signal
        ├── resolve exact TaskSession
        ├── fence expected generation
        ├── derive provider effect from postcondition
        ├── reserve effect durably
        └── execute provider adapter
                 │
                 ▼
               GitHub
```

The worker does not name:

- obligation;
- run;
- revision;
- repository;
- commit;
- context;
- desired state;
- provider operation;
- provider request body.

Those values are not merely rejected when wrong. They are absent from the legal worker protocol.

## Hostile cases

The untrusted worker:

- attempts direct GitHub status mutation of the authorized coordinate;
- attempts direct mutation of a forged sibling coordinate;
- emits one valid `effect-ready` signal;
- tries to smuggle run, obligation, revision, repository, commit, context, state, an entire effect object, and an unrelated extra field into otherwise valid signals.

The direct writes must return HTTP 403.

Every signal carrying an authority-bearing field must fail protocol validation before execution authority changes.

The broker then binds the legal signal to the exact authoritative run and generation.

## Session and replay fences

A TaskSession is broker-side state, not a worker credential.

It binds:

```text
run id
obligation id
claimed revision
worker execution generation
```

After the first authorized effect:

1. the original worker session is stale and must fail with `TASK_SESSION_STALE`;
2. a freshly bound session may rotate execution authority;
3. the existing durable reservation must still reject replay with `UNRESOLVED_EFFECT` before a second provider mutation occurs.

Recovery then observes exactly one authorized status record and settles from canonical readback.

## Provider command derivation

For the GitHub commit-status path the obligation postcondition is sufficient authority for the provider adapter:

```text
github commit-status postcondition
        │
        ▼
deriveGithubCommitStatusEffect(...)
        │
        ▼
trusted GitHub effect adapter
        │
        ▼
POST /repos/{canonical repo}/statuses/{sha}
```

The experiment no longer stores a duplicate `packet.effect` for this path.

## What success does not mean

This does not make GitHub's credential itself coordinate-scoped. The broker remains trusted and its provider credential is broader than the task.

A task-specific local executable can still be useful ergonomically, but it does not provide this security property. A hostile worker can bypass local software. The actual boundary is isolated provider credentials, broker-side task-session binding, exact-generation fencing, provider-effect derivation from authority, and durable reservation.
