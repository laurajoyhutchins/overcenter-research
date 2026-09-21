# `overcenter-exec`

`overcenter-exec` is the narrow native execution boundary justified by the Rust confinement experiments.

It does **not** decide what work is eligible, claim work, interpret provider state, settle work, or mutate project truth. TypeScript remains authoritative for those semantics. The trusted TypeScript caller renders one exact execution manifest, hashes those exact bytes, and pipes those same bytes directly to the launcher on stdin.

```text
TypeScript authority
  open exact workspace -> FD 3
  open finite delegated cgroup parent
  create + pin unique exact cgroup leaf -> FD 4
  verify workspace dev/inode
  render manifest + resource/supervisor limits
  SHA-256(exact bytes)
            |
            | stdin bytes + workspace FD 3 + cgroup FD 4
            v
      overcenter-exec
        parse before worker exists
        verify/reuse workspace FD
        verify exact cgroup leaf FD
        apply + verify memory/PID/CPU limits
        migrate launcher before worker exists
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
memory_max_bytes<TAB>positive-decimal
pids_max<TAB>positive-decimal
cpu_quota_us<TAB>positive-decimal
cpu_period_us<TAB>positive-decimal
arg<TAB>...
env<TAB>NAME<TAB>VALUE
runtime_ro<TAB>/exact/path
runtime_exec<TAB>/exact/path
```

Singleton records may appear once. Environment names and runtime paths may not repeat. Unknown records fail closed. Runtime paths are explicit rather than a hard-coded `/usr` or `/etc` allowance.

The TypeScript emitter returns the exact bytes, their SHA-256, and the decoded supervisor/resource limits from those same bytes. `runConfinedWorker` enforces the transport limits, pipes precisely the hashed bytes to stdin, passes the verified workspace object on FD 3, and passes one already-created exact cgroup-v2 leaf on FD 4. The trusted supervisor retains the finite delegated parent separately. Timeout, output, memory, PID, or CPU policy therefore cannot change without changing the attempt identity. Combined stdout/stderr buffering also has a fixed 64 MiB implementation ceiling, regardless of manifest input.

## Physical guarantees in v1

On Linux x86-64 with Landlock ABI >= 6, the launcher:

- reads and parses a bounded, canonical manifest before creating the worker process;
- refuses effective uid 0, switchable real/effective/saved UID or GID state, any nonzero effective/permitted/inheritable Linux capability set, and inherited scheduling policies outside the fair class; only `SCHED_OTHER`, `SCHED_BATCH`, and `SCHED_IDLE` are admitted because `cpu.max` does not govern realtime/deadline scheduling classes;
- consumes the already-open workspace object from FD 3, verifies its directory type and device/inode identity, and binds Landlock directly to that object;
- verifies FD 4 is an exact cgroup-v2 domain leaf with the required kernel interfaces, writes and reads back `memory.max`, `pids.max`, and `cpu.max`, forces `cpu.max.burst=0`, disables swap, enables group OOM handling, and migrates itself into that pinned object before untrusted code exists;
- keeps workspace file/dir mutation rights but withholds blanket execute authority plus character-device, block-device, Unix-socket-node, device-ioctl, and pathname-Unix-socket resolution authority;
- allows kernel execution only through the selected program or explicitly declared executable runtime objects; a sibling executable merely present in the writable workspace is denied;
- requires the selected program and runtime closure to resolve to regular files that are neither worker-owned nor writable under the worker's effective credentials, covering metadata operations that Landlock does not mediate;
- de-duplicates runtime closure by opened device/inode identity, so path or symlink aliases cannot union read-only and executable authority;
- enters the pinned workspace with `fchdir`, so later pathname replacement cannot retarget the worker's current directory;
- clears the worker environment and adds back only manifest-declared variables;
- closes every inherited file descriptor above stderr with `close_range(3, ...)` after consuming the intentional workspace FD;
- denies process-group/session escape, same-UID scheduler/resource-control syscalls, creation of sockets/socketpairs, System V IPC and POSIX message queues, inherited kernel-keyring access, `io_uring_setup`, and `pidfd_getfd`; it also denies `MAP_HUGETLB` and `MFD_HUGETLB` allocation paths so HugeTLB cannot bypass the ordinary memory controller; the x32 syscall-number namespace is killed before deny-list matching;
- requires Landlock ABI >= 6, so TCP bind/connect restrictions plus signal and abstract-Unix-socket process scoping are mandatory rather than optional;
- replaces the launcher process with the worker using `exec`, leaving no privileged helper process behind;
- bounds wall-clock time plus combined stdout/stderr bytes from manifest-bound policy; timeout or output overflow uses the exact cgroup leaf as the descendant kill authority and only signals the direct child as a setup/terminal fallback;
- after the child closes, kills the exact leaf, waits for `cgroup.events populated=0`, then captures final memory/PID peaks, OOM/PID-limit events, CPU usage, and throttling counters;
- binds that evidence to the pinned cgroup device/inode, verifies the parent entry still names the same object, and only then removes the empty leaf.

Stdin/stdout/stderr are the intentional process interface. The trusted caller closes stdin after sending the complete manifest, so the worker inherits an EOF'd input stream rather than an ambient capability.

The launcher is intentionally fail-closed when required kernel mechanisms are unavailable or when the inherited scheduling class would make the declared CPU ceiling unenforceable.

### Deliberate residual boundary

This is authority confinement, not a complete VM boundary. Current Landlock does not hide all pathname metadata (for example `stat`/`access`) or mediate advisory locking such as `flock`; the launcher therefore does not claim metadata confidentiality or isolation from lock interactions on explicitly granted runtime objects. CPU, memory, and PID containment are now part of the execution boundary. Device-specific I/O limits and workspace disk quotas remain outside this slice because they require an explicit storage/device authority contract rather than a portable scalar limit.

## Proof

Run:

```sh
bash runtime/overcenter-exec/proof.sh
```

The proof checks canonical manifest rejection, exact FD-based workspace pinning across pathname replacement, rejection of non-regular/worker-mutable/aliased execution closure objects, explicit-only workspace execution, outside read/write denial, ambient environment and kernel-keyring removal, inherited-FD closure, process-group escape denial, same-UID host-process control denial, HugeTLB allocation denial, System V/POSIX IPC denial, TCP/Unix-socket denial, x32 seccomp rejection, and preservation of authorized workspace effects.

The hosted proof additionally exercises the real TypeScript supervisor against cgroup v2: normal completion must produce exact resource evidence, timeout/output overflow must remove the exact leaf, unrelated stale leaves must remain untouched, and the hostile PID/CPU/memory probes must demonstrate actual kernel enforcement.

This is a physical computation boundary only. Provider mutation credentials still belong in a separate trusted broker, not in this worker sandbox.


## Host cgroup contract

The host prepares a **finite aggregate cgroup-v2 pool**. The trusted supervisor opens that parent with no-follow semantics and fails closed unless it is a domain cgroup whose `cgroup.subtree_control` contains `cpu`, `memory`, and `pids`, and whose own `memory.max`, `pids.max`, and `cpu.max` are finite, whose `cpu.max.burst` is zero, whose `cgroup.max.descendants` is finite, and whose `cgroup.max.depth` is exactly 1. These parent limits bound aggregate worker pressure; per-attempt manifest values are child ceilings, not capacity reservations.

For each launch, TypeScript creates a fresh random leaf beneath that parent, opens and pins the leaf, records its device/inode identity, and passes only that exact leaf on FD 4. Rust neither selects nor creates cgroups by PID or pathname. It configures and enters FD 4, then Landlock and `close_range` remove the leaf capability before worker `exec`.

The supervisor keeps its own leaf FD and parent FD for termination, final evidence, identity verification, and removal. It does not infer cgroup ownership from a PID, and it does not sweep unrelated stale leaves. Recovery of an orphaned bounded leaf after supervisor death remains an authority-aware recovery operation outside this low-level launcher. The finite descendant-count limit ensures such orphans can exhaust only a bounded leaf budget and then fail closed rather than grow the cgroup hierarchy without limit.

