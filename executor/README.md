# Overcenter computation executor

This directory contains the production physical computation executor.

It exists because the differential experiment in `experiments/executor-language-comparison/` showed a material operational advantage for this narrow role while preserving the same hostile-case semantics as the TypeScript alternative.

## Authority boundary

The executor may:

- validate an already-authorized computation envelope
- start an exact process specification
- enforce bounded concurrency
- cancel the exact run/generation/authority identity
- supervise a process group
- capture bounded stdout/stderr while hashing the full streams
- emit attempt evidence

The executor may not:

- derive graph eligibility
- claim work
- settle obligations
- interpret provider state
- hold provider mutation credentials
- decide whether project state became true

Attempt evidence is not a settlement receipt.

## Production topology

```text
trusted TypeScript authority host
            |
       Unix socket
            |
            v
isolated worker/container
+-------------------------------+
| overcenter-executor           |
|   |                           |
|   +-- explicit task env only  |
|   +-- bounded process groups  |
|   +-- no provider authority   |
+-------------------------------+
```

The production TypeScript client connects to an existing Unix socket. It does not spawn the executor. Deployment is responsible for running the executor in a separate UID/container without provider credentials.

The binary supports `--stdio` only for tests and containment experiments.

## Recovery

Executor state is intentionally ephemeral. A client disconnect cancels local work and ends that executor lifetime.

Recovery does not reconstruct an in-memory queue. Overcenter re-reads durable facts and either:

- acquires a fresh execution generation for computation known safe to repeat, or
- follows effect observation/reconciliation when an external effect may have occurred.

## Catastrophic death

Normal cancellation kills the entire task process group, escalating from SIGTERM to SIGKILL.

If the executor itself is SIGKILLed, it can no longer perform process-group cleanup. Linux `Pdeathsig` protects the direct child, but arbitrary grandchildren are not trusted to disappear.

Therefore the worker container is the outer containment boundary. CI deliberately kills the executor while a hostile grandchild survives, then asserts that destroying the worker container removes every remaining host process from that container.

## Wire contract

See `contracts/computation-execution-v1/`.

Execution-spec identity is bound to exact bytes:

```text
process spec bytes
      |
      +-- base64 ------------------+
      |                            |
      +-- sha256 ------------------+--> execution permit envelope
```

No cross-language JSON canonicalization assumption is part of the authority boundary.
