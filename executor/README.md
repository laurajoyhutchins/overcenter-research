# Overcenter computation executor

This directory contains the production physical computation executor.

It exists because the differential admission experiment preserved in PR #66 showed a material operational advantage for this narrow role while preserving the same hostile-case semantics as the TypeScript alternative.

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

The production TypeScript client connects to an existing Unix socket. It does not spawn the executor. Deployment is responsible for running the executor in a separate disposable containment domain without provider credentials. The supported profile also requires no task network, a read-only container root/source snapshot, `no-new-privileges`, explicit capabilities only, and bounded PID/memory/CPU/open-file/per-file-size resources. Aggregate workspace bytes remain an outer worker-host quota.

The executable definition of that supported host profile is [`src/production-containment.ts`](../src/production-containment.ts). Production proofs and self-dogfood consume that module rather than restating Docker flags. Changing the profile therefore changes the attested execution context and its proof harness together.

Executor base images are separately pinned to immutable registry digests in [`runtime-images.json`](./runtime-images.json). Self-dogfood receives a `git archive` of the exact source revision rather than the live checkout, so `.git`, checkout credentials, untracked files, and other host checkout state are outside the worker input.

Self-dogfood runs the production regression plus the deterministic experiment suite inside this production containment profile. The separate `proof:local` Evidence lane additionally runs Git reference-backend stress; that stress harness does not define the production worker resource budget.

Production socket mode requires `--task-uid` and `--task-gid`. Both must differ from the executor identity; when `--socket-gid` is used to grant the trusted host access to the socket, the task GID must differ from that group too. Task processes are launched with supplementary groups replaced by the task GID only; executor and trusted-socket groups do not cross the boundary.

A typical container boundary therefore has three distinct authorities:

```text
trusted host GID  -> Unix socket only
executor UID/GID  -> supervisor + task launch
task UID/GID      -> workspace computation only
```

The workspace must be mounted with permissions appropriate for the configured task UID/GID. The executor pins the workspace root as a directory descriptor and traverses task cwd components with no-follow directory opens; cwd symlink components are rejected rather than resolved through a mutable namespace.

The Unix socket must live in a dedicated directory that the task UID/GID cannot write. Production startup checks the directory owner/group/mode and fails closed when the configured task identity can write it; the socket is created under a restrictive umask before its final `0660` mode is applied. The established one-connection lifetime then keeps the authority channel outside task namespace control. POSIX ACLs or other deployment mechanisms must not separately grant the task write access to that directory.

Before any computation command is accepted as production-ready, the socket peer emits exactly one `overcenter-executor-hello-v1` record containing the trusted execution-context digest and containment-domain id supplied at executor launch. The TypeScript client compares those values with the authority-side expected values before it may claim or rotate replayable computation authority. A socket peer that cannot produce the exact hello fails closed.

The replay-safe execution-context digest covers the immutable executor image identity, exact source revision, task UID/GID, and the enforced containment profile. The containment id is intentionally separate and changes between disposable worker instances.


`--unsafe-test-same-uid` is an explicit escape hatch for local protocol tests and is accepted only with `--stdio`. Production socket mode has no same-UID escape hatch: it requires explicit distinct task credentials and fails closed otherwise.

The binary supports `--stdio` only for tests and containment experiments.

## First production workload

The first authority-side production integration is the pure `test` workload in `src/computation-runner.ts`. CI exercises that path through the production Unix-socket mode in a disposable container: repository source is mounted read-only, the task runs as UID/GID 65532, and the host observes only the resulting workspace artifact.

TypeScript selects an already-derived `READY` test obligation, acquires the exact claim/generation, converts its durable process specification to `ProcessSpecV1`, and sends that exact computation to this executor. Go returns attempt evidence only. TypeScript independently observes the obligation postcondition and settles from that observation.

No effect reservation is created for this pure-computation path. That is legal only for the mechanically confined replay-safe profile. A nonzero/failed attempt is rejected before observation can settle success, and a zero exit code is still not project truth: independent observation must satisfy the postcondition.

If the executor transport dies, TypeScript records an interrupted-execution receipt. A successor reconstructs the run and process specification from durable facts, acquires a fresh execution generation, recreates the workspace, and may retry the pure computation. Provider-mutating work does not use this path.

## Recovery

Executor state is intentionally ephemeral. A client disconnect cancels local work and ends that executor lifetime.

Recovery does not reconstruct an in-memory queue. Overcenter re-reads durable facts and either:

- acquires a fresh execution generation for computation known safe to repeat, or
- follows effect observation/reconciliation when an external effect may have occurred.

## Catastrophic death

Normal cancellation first fences the task process group, escalating from SIGTERM to SIGKILL.

Process groups are not treated as a complete process tree. The executor also marks itself as a Linux child subreaper. After every top-level task exit it checks for descendants that outlived that parent, including descendants that created a new session/process group. With no other top-level task active, those descendants are SIGKILLed and reaped before executor capacity is reusable. A nominally successful task that leaves a background descendant is reported failed.

If orphan attribution becomes ambiguous while other top-level tasks are still active, the executor fails its entire lifetime rather than guessing across task boundaries. The trusted host therefore treats the transport loss as a worker failure and recovery begins from durable facts.

If the executor itself is SIGKILLed, none of this local cleanup is available. Linux `Pdeathsig` protects the direct child, but arbitrary detached descendants are not trusted to disappear.

Therefore the worker container is the outer containment boundary. CI deliberately kills the executor while a detached hostile grandchild survives, then asserts that destroying the worker container removes every remaining host process from that container.

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
