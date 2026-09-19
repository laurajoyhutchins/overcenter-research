# Computation execution contract v1

This contract is the production boundary between Overcenter's trusted TypeScript authority layer and the Go physical computation executor.

The executor receives only already-authorized computation. It does not receive graph edges, lifecycle transitions, settlement instructions, provider mutation authority, or provider credentials.

## Request

`overcenter-computation-execution-v1` binds:

- run and obligation identity
- claimed revision
- exact execution generation and authority commit
- execution capability and its existing SHA-256 binding
- exact execution-spec bytes as canonical base64
- SHA-256 of those exact bytes

The executor decodes and verifies the bytes before parsing `overcenter-process-spec-v1`.

## Process spec

The process spec is intentionally restrictive:

- absolute executable path
- argv array, never a shell command string
- workspace-relative cwd
- explicit environment only
- timeout
- bounded stdout/stderr capture

The executor process environment is not inherited by the task.

At execution time the workspace root is pinned as an open directory. The cwd is traversed relative to that directory with no-follow directory opens, so cwd symlink components are rejected and a checked pathname cannot be swapped before process start.

The contract binds the exact executable **path string**, not the executable file contents. The admitted replayable test workload therefore adds an authority-side execution-context digest to the durable packet. Production deployment derives that digest from the task-immutable image, exact source snapshot, and containment profile, and the trusted client refuses an executor whose context does not match. Because the packet is part of the obligation key, changing that context changes obligation meaning rather than silently replaying different bytes.

The writable workspace is not an input channel for the production replayable profile: every attempt starts from an empty workspace. Source is an exact read-only snapshot outside that workspace. General mutable-input closure remains a separate problem and is not implied by the v1 process-spec digest.

## Evidence

`overcenter-computation-attempt-evidence-v1` is attempt evidence, not settlement authority. It reports exact execution identity, process outcome, exit/signal information, and bounded stdout/stderr captures plus full-stream digests.

A zero exit code does not make an obligation DONE. Observation and settlement remain TypeScript/kernel responsibilities.

## Cancellation

Commands use `overcenter-executor-command-v1`.

- `execute` carries one computation execution request.
- `cancel` identifies the exact run generation and authority commit to cancel.

All executor state is ephemeral. Process IDs, cancellation handles, and descendant-cleanup bookkeeping exist only to contain the current physical attempt. They are never project truth and are not reconstructed after executor death.

Killing the executor loses that local bookkeeping by design; durable recovery starts from Overcenter facts and a fresh execution generation.

## Cross-language rule

The spec bytes are authoritative bytes. Neither side is allowed to hash a reserialized object and assume another language serializes it identically.
