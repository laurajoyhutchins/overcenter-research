# `overcenter-exec`

`overcenter-exec` is the narrow native execution boundary justified by the Rust confinement experiments.

It does **not** decide what work is eligible, claim work, interpret provider state, settle work, or mutate project truth. TypeScript remains authoritative for those semantics. The trusted TypeScript caller renders one exact execution manifest, hashes those exact bytes, and pipes those same bytes directly to the launcher on stdin.

```text
TypeScript authority
  render manifest bytes
  SHA-256(exact bytes)
            |
            | stdin: same exact bytes
            v
      overcenter-exec
        parse before worker exists
        pin workspace inode
        enumerate explicit runtime closure
        Landlock filesystem policy
        clear ambient environment
        close inherited FDs
        deny new sockets / io_uring socket bypass
            |
            v
      untrusted worker
            |
            v
  attempt evidence / settlement in TypeScript
```

There is deliberately no manifest pathname in the production launcher contract. That removes a digest-then-open race in which mutable pathname contents could differ from the bytes TypeScript authorized.

## Manifest contract

The manifest grammar is deliberately small and strict. `src/execution-manifest.ts` is the canonical emitter and `src/confined-executor.ts` is the trusted transport.

```text
OVERCENTER_EXEC_V1
task_id<TAB>...
workspace<TAB>/absolute/path
workspace_dev<TAB>decimal
workspace_ino<TAB>decimal
program<TAB>/absolute/program
arg<TAB>...
env<TAB>NAME<TAB>VALUE
runtime_ro<TAB>/exact/path
runtime_exec<TAB>/exact/path
```

Singleton records may appear once. Environment names and runtime paths may not repeat. Unknown records fail closed. Runtime paths are explicit rather than a hard-coded `/usr` or `/etc` allowance.

The TypeScript emitter returns both the exact bytes and their SHA-256. `runConfinedWorker` pipes precisely those bytes to stdin and returns that digest with the process result, giving attempt evidence an exact execution-manifest identity without introducing a mutable manifest file.

## Physical guarantees in v1

On Linux x86-64 with Landlock ABI >= 3, the launcher:

- reads and parses the complete manifest before creating the worker process;
- opens the workspace with `O_PATH | O_DIRECTORY | O_NOFOLLOW` and verifies device/inode identity before using it;
- binds Landlock rules directly to that pinned workspace FD;
- grants filesystem access only to the workspace, program, and explicitly enumerated runtime closure;
- enters the pinned workspace with `fchdir`, so later pathname replacement cannot retarget the worker's current directory;
- clears the worker environment and adds back only manifest-declared variables;
- closes every inherited file descriptor above stderr with `close_range(2)`;
- denies creation of sockets and socketpairs with seccomp, and denies `io_uring_setup` and `pidfd_getfd` as bypass surfaces;
- additionally denies TCP bind/connect through Landlock on ABI >= 4 and scopes signals/abstract Unix sockets on ABI >= 6;
- replaces the launcher process with the worker using `exec`, leaving no privileged helper process behind.

Stdin/stdout/stderr are the intentional process interface. The trusted caller closes stdin after sending the complete manifest, so the worker inherits an EOF'd input stream rather than an ambient capability.

The launcher is intentionally fail-closed when required kernel mechanisms are unavailable.

## Proof

Run:

```sh
bash runtime/overcenter-exec/proof.sh
```

The proof checks workspace identity replacement, outside read/write denial, undeclared host-file denial, ambient GitHub/AWS credential removal, inherited-FD closure, TCP denial, Unix socket denial, and preservation of authorized workspace effects.

The TypeScript regression additionally proves the launcher receives byte-for-byte the manifest whose SHA-256 it reports.

This is a physical computation boundary only. Provider mutation credentials still belong in a separate trusted broker, not in this worker sandbox.
