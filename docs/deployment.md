# Deployment and trust boundaries

Overcenter's supported slice is a composition of narrow authorities. Deploying all binaries in one credential-rich process would erase guarantees that the source deliberately keeps separate.

## Logical topology

    project authority / TypeScript
      graph, admission, claims, EffectAuthority, settlement
                    |
                    +-> trusted provider broker
                    |     provider write credentials
                    |     reserve before mutation
                    |
                    +-> computation transport
                          exact execution context
                          Unix socket hello
                                  |
                                  v
                          isolated Go executor
                                  |
                                  v
                          untrusted task process

A separate Rust launcher (`overcenter-exec`) provides a native Landlock/seccomp/cgroup confinement primitive for controlled Linux x86-64 execution. It does not replace the TypeScript authority layer or the Go computation protocol.

## Authority placement

| Component | May own | Must not own |
| --- | --- | --- |
| TypeScript authority/kernel | graph semantics, claim/recovery fencing, effect authorization, verification, settlement | arbitrary provider truth without observation |
| trusted provider broker | narrowly admitted provider credential and exact authorized mutation | obligation selection or self-settlement |
| Go executor | bounded physical process execution and attempt evidence | provider credentials, graph eligibility, project truth |
| Rust confinement launcher | physical process/filesystem/syscall/resource confinement | project semantics or provider authority |
| portable worker client | assignment validation, task execution, candidate packaging | claims, provider mutation, verification, settlement |

## Production computation boundary

The current Go socket profile expects:

- an executor running outside the trusted TypeScript process;
- distinct executor and task UID/GID identities;
- a dedicated Unix-socket directory the task cannot write;
- no task network;
- read-only root/source input plus a fresh writable workspace;
- `no-new-privileges` and explicit minimal capabilities;
- bounded PID, memory, CPU, open-file, and per-file-size resources;
- an exact executor/source/containment digest checked in the socket hello.

See [`../src/execution/executor/README.md`](../src/execution/executor/README.md) for the executable contract.

## Native confinement boundary

The Rust launcher additionally pins exact workspace and cgroup objects by file descriptor, applies Landlock and seccomp before worker execution, clears ambient environment and inherited descriptors, and captures final resource evidence only after the exact cgroup leaf is killed and observed empty.

See [`../src/execution/confinement/README.md`](../src/execution/confinement/README.md).

## Controlled versus foreign workers

Overcenter distinguishes two guarantees:

- **authority confinement:** an untrusted worker cannot manufacture Overcenter project truth;
- **effect confinement:** the substrate physically prevents the worker from performing undelegated external effects.

The first is the core correctness requirement. The second is an optional strengthening that depends on the actual host capability boundary. A foreign agent sandbox that already possesses provider credentials cannot have those ambient powers revoked by an inner Overcenter process sandbox.

See [ADR-0010](./adr/0010-controlled-vs-uncontrolled-agent-harnesses.md).
