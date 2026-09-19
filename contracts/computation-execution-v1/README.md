# Computation execution contract v1

This contract is the production boundary between Overcenter's trusted TypeScript authority layer and the Go physical computation executor.

The executor receives only already-authorized computation. It does not receive graph edges, lifecycle transitions, settlement instructions, provider mutation authority, or provider credentials.

## Machine-readable contract

This directory is an ODCS-inspired contract package rather than a prose-only protocol note.

- `contract.json` owns contract identity, lifecycle, compatibility, semantic identity, quality evidence, and authoritative-definition references.
- `schema.json` is authoritative for mechanically knowable wire structure.
- `process-spec-conformance.json` carries executable positive and hostile examples.
- this README explains semantics and trust boundaries that are not usefully expressed as field constraints.

If prose and the machine-readable wire structure disagree, the machine-readable structure wins and the contract regression must fail until the implementations and explanation are repaired. TypeScript and Go remain independent implementations that must prove conformance; neither implementation is the contract merely because it compiled first.

## Executor hello

Production Unix-socket sessions begin with one trusted-peer identity record:

```json
{
  "schema": "overcenter-executor-hello-v1",
  "execution_context_sha256": "sha256:...",
  "containment_id": "..."
}
```

Replayable authority must wait for that hello and match it against the authority-side expected execution context and containment domain. The hello is not worker evidence and carries no settlement authority.

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

The contract binds the exact executable **path string**, not the executable file contents. Replayable production workloads therefore bind a separate execution-context digest over the immutable image/source and containment profile before execution authority is granted. Production deployment must therefore provide executable/toolchain paths from task-immutable image or mount content. Binding toolchain bytes, if required for a workload class, belongs in the authority-side input identity rather than being inferred by Go.

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
