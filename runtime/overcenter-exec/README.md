# `overcenter-exec`

`overcenter-exec` is the narrow native execution boundary justified by the Rust confinement experiments.

It does **not** decide what work is eligible, claim work, interpret provider state, settle work, or mutate project truth. TypeScript remains authoritative for those semantics. The trusted TypeScript caller renders one exact execution manifest, hashes those exact bytes, and pipes those same bytes directly to the launcher on stdin.

```text
TypeScript authority
  open exact workspace -> FD 3
  verify dev/inode
  render manifest + supervisor limits
  SHA-256(exact bytes)
            |
            | stdin bytes + workspace FD 3
            v
      overcenter-exec
        parse before worker exists
        verify/reuse workspace FD
        enumerate explicit runtime closure
        Landlock filesystem policy
        clear ambient environment
        close inherited FDs
        deny sockets, host IPC, keyrings, bypass syscalls
            |
            v
      untrusted worker
            |
            v
  attempt evidence / settlement in TypeScript
```

There is deliberately no manifest-file pathname in the production launcher contract. The trusted transport opens the workspace once with no-follow semantics, verifies that FD's device/inode against the manifest, and passes the same object on FD 3. Rust re-verifies FD 3 and never reopens the workspace pathname, so replacing that pathname after open cannot retarget the sandbox.

## Manifest contract

The manifest grammar is deliberately small and strict. `src/execution-manifest.ts` is the canonical emitter and `src/confined-executor.ts` is the trusted transport.

```text
OVERCENTER_EXEC_V1
task_id<TAB>...
workspace<TAB>/absolute/path
workspace_dev<TAB>decimal
workspace_ino<TAB>decimal
program<TAB>/absolute/program
timeout_ms<TAB>positive-decimal
max_output_bytes<TAB>positive-decimal
arg<TAB>...
env<TAB>NAME<TAB>VALUE
runtime_ro<TAB>/exact/path
runtime_exec<TAB>/exact/path
```

Singleton records may appear once. Environment names and runtime paths may not repeat. Unknown records fail closed. Runtime paths are explicit rather than a hard-coded `/usr` or `/etc` allowance.

The TypeScript emitter returns the exact bytes, their SHA-256, and the decoded supervisor limits from those same bytes. `runConfinedWorker` enforces those manifest-bound limits, pipes precisely the hashed bytes to stdin, and passes the verified workspace object on FD 3. Timeout and output policy therefore cannot change without changing the attempt identity.

## Physical guarantees in v1

On Linux x86-64 with Landlock ABI >= 6, the launcher:

- reads and parses a bounded, canonical manifest before creating the worker process;
- refuses effective uid 0, switchable real/effective/saved UID or GID state, and any nonzero effective, permitted, or inheritable Linux capability set;
- consumes the already-open workspace object from FD 3, verifies its directory type and device/inode identity, and binds Landlock directly to that object;
- keeps workspace file/dir mutation rights but withholds blanket execute authority plus character-device, block-device, Unix-socket-node, device-ioctl, and pathname-Unix-socket resolution authority;
- allows kernel execution only through the selected program or explicitly declared executable runtime objects; a sibling executable merely present in the writable workspace is denied;
- requires the selected program and runtime closure to resolve to regular files that are neither worker-owned nor writable under the worker's effective credentials, covering metadata operations that Landlock does not mediate;
- de-duplicates runtime closure by opened device/inode identity, so path or symlink aliases cannot union read-only and executable authority;
- enters the pinned workspace with `fchdir`, so later pathname replacement cannot retarget the worker's current directory;
- clears the worker environment and adds back only manifest-declared variables;
- closes every inherited file descriptor above stderr with `close_range(3, ...)` after consuming the intentional workspace FD;
- denies process-group/session escape, same-UID scheduler/resource-control syscalls, creation of sockets/socketpairs, System V IPC and POSIX message queues, inherited kernel-keyring access, `io_uring_setup`, and `pidfd_getfd`; the x32 syscall-number namespace is killed before deny-list matching;
- requires Landlock ABI >= 6, so TCP bind/connect restrictions plus signal and abstract-Unix-socket process scoping are mandatory rather than optional;
- replaces the launcher process with the worker using `exec`, leaving no privileged helper process behind;
- runs the launcher in a dedicated process group and bounds wall-clock time plus combined stdout/stderr bytes from manifest-bound policy; timeout or output overflow kills the whole group.

Stdin/stdout/stderr are the intentional process interface. The trusted caller closes stdin after sending the complete manifest, so the worker inherits an EOF'd input stream rather than an ambient capability.

The launcher is intentionally fail-closed when required kernel mechanisms are unavailable.

### Deliberate residual boundary

This is authority confinement, not a complete VM boundary. Current Landlock does not hide all pathname metadata (for example `stat`/`access`) or mediate advisory locking such as `flock`; the launcher therefore does not claim metadata confidentiality or isolation from lock interactions on explicitly granted runtime objects. It also does not provide cgroup-style PID, memory, CPU, or disk quotas. The manifest-bound timeout/output limits cap the trusted transport, while aggregate resource quotas remain an outer disposable-worker-host responsibility.

## Proof

Run:

```sh
bash runtime/overcenter-exec/proof.sh
```

The proof checks canonical manifest rejection, exact FD-based workspace pinning across pathname replacement, rejection of non-regular/worker-mutable/aliased execution closure objects, explicit-only workspace execution, outside read/write denial, ambient environment and kernel-keyring removal, inherited-FD closure, process-group escape denial, same-UID host-process control denial, System V/POSIX IPC denial, TCP/Unix-socket denial, x32 seccomp rejection, and preservation of authorized workspace effects. TypeScript regressions additionally prove exact FD 3 transport plus manifest-bound timeout and output enforcement.

The TypeScript regression additionally proves the launcher receives byte-for-byte the manifest whose SHA-256 it reports.

This is a physical computation boundary only. Provider mutation credentials still belong in a separate trusted broker, not in this worker sandbox.
