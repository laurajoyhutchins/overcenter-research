# ADR-0008: Admit Rust only for native worker confinement

**Status:** Accepted

## Decision

Rust is admitted to the supported Overcenter slice only for a small native worker-confinement substrate.

The admitted boundary is `runtime/overcenter-exec`. Trusted TypeScript opens and identity-checks the exact workspace object, passes it on FD 3, opens a finite delegated cgroup-v2 parent, creates and pins one fresh exact child leaf, passes that leaf on FD 4, renders one strict execution manifest including supervisor and resource limits, computes the SHA-256 of those exact bytes, and pipes the same bytes to the launcher on stdin. The launcher may own only mechanically enforceable process-boundary work: exact-object workspace pinning, filesystem/process confinement, ambient-authority removal, bounded transport supervision, and replacement of the launcher with the untrusted worker.

Rust does not own graph eligibility, project projection, claims, recovery policy, provider interpretation, provider mutation, verification, settlement, or project truth.

The existing Go executor remains the supported pure-computation mechanism. This ADR does not claim that the Go executor and Rust launcher are one combined execution path. Any such integration must earn its own exact-identity and recovery evidence.

## Evidence

PR #72 established the differential justification rather than treating Rust as a preference:

- a plausible Node `realpath + O_NOFOLLOW` baseline lost a parent-directory check/open race and read outside the authorized root;
- a Rust `openat2` path bound to an already-open directory refused the escaped coordinate;
- a Rust Landlock launcher confined an ordinary Node worker and its descendants, denying outside reads/writes and descendant escape attempts.

The hosted proof for PR #72 passed at exact head `b9970e7ce99e6464e6bf25ad4fa4c9a574e0bb9c` in workflow run 35425228115.

PR #84 converted that result into a reusable launcher rather than the experimental per-task generated capsule. Its pre-rebase hosted proof passed at exact head `f3176c6e520419d08646859757ceb0462ace3678` in workflow run 35462407651. The rebased implementation is part of `npm run proof:production`, so promotion remains gated by the repository's exact-head Merge gate.

## Why this boundary

The native launcher buys properties that are awkward or unavailable through the ordinary Node process API:

- Landlock filesystem policy inherited by descendants;
- a workspace rule and working directory bound to the caller's already-open directory FD rather than a reopened path;
- explicit-only execution authority plus immutable regular-file program/runtime closure;
- seccomp denial of socket creation, host System V/POSIX IPC, inherited kernel-keyring access, process-group escape, same-UID host-process control, HugeTLB allocation bypasses, x32 syscall aliasing, and selected bypass surfaces;
- mandatory Landlock process scoping for signals and abstract Unix sockets;
- fail-closed rejection of privileged or switchable caller credentials;
- deterministic removal of ambient environment and inherited descriptors before `exec`;
- manifest-bound wall-clock/output supervision plus cgroup-v2 memory, PID, and CPU limits with exact-leaf whole-cgroup termination and final post-kill kernel evidence.

Those are execution-correctness mechanisms, not reasoning or authority semantics.

## Rejected alternatives

### Rewrite orchestration in Rust

Rejected. The experiments demonstrated an advantage at the kernel/process boundary, not in graph semantics, provider meaning, projection, or settlement.

### Keep Rust experimental forever

Rejected. The confinement result is differential, adversarial, reproducible, and narrow enough to maintain as a supported mechanism.

### Generate a bespoke Rust capsule for every task

Rejected as the production design. Code generation is cheap, but multiplying trusted implementations is not. One generic launcher plus an exact data-bound manifest gives a smaller trusted surface.

### Treat the launcher as the provider-authorization boundary

Rejected. Filesystem/process confinement does not grant or interpret provider authority. Provider credentials and provider mutation remain separately controlled trusted effects.

## Consequences

- Supported hosts for this launcher are deliberately Linux x86-64, must provide Landlock ABI >= 6 and the required seccomp behavior, and must invoke the launcher without uid 0, switchable saved credentials, or ambient process capabilities.
- The trusted transport must supply the exact workspace directory on FD 3; pathname replacement after that open is intentionally irrelevant.
- Program/runtime files are explicit immutable regular-file execution-closure inputs, not blanket access to `/usr` or `/etc`; aliases are de-duplicated by opened inode identity.
- Writable workspace authority excludes blanket execute, special-device/socket-node creation, device ioctls, and pathname-Unix-socket resolution.
- Landlock does not currently provide pathname-metadata confidentiality or advisory-lock isolation, and the launcher does not claim either.
- CPU, memory, and PID budgets are execution identity and are enforced in one host-created, FD-pinned cgroup-v2 leaf before untrusted code runs.
- The trusted supervisor requires the direct delegated parent to have finite aggregate CPU, memory, and PID limits; child values are ceilings, not capacity reservations.
- PID values and cgroup names are locators, not authority. Termination, evidence, and removal stay bound to the exact leaf object and its device/inode identity.
- Resource evidence is sampled only after `cgroup.kill` and `cgroup.events populated=0`, so detached descendants cannot continue consuming resources after the reported sample.
- The worker cannot request HugeTLB through `MAP_HUGETLB`, `MFD_HUGETLB`, or System V shared memory, avoiding a host-dependent gap in ordinary `memory.max` accounting.
- Trusted combined stdout/stderr buffering has a fixed 64 MiB per-attempt implementation ceiling in addition to manifest policy.
- The host owns cgroup delegation and parent-controller setup; the launcher fails closed rather than enabling or widening its parent authority.
- Device-specific I/O and workspace disk quotas remain a separate storage-authority problem.
- Aggregate trusted-supervisor memory across concurrent attempts remains a host/supervisor capacity concern; the per-attempt output ceiling is not a global memory quota.
- A missing required kernel primitive or privileged caller context fails closed.
- The Rust toolchain is pinned and its hostile proof is part of the production proof command.
- The launcher remains disposable physical machinery. Durable execution truth stays in TypeScript + SQLite.

## Revisit when

Revisit this decision if a portable mechanism demonstrates equivalent descendant-inherited confinement with a smaller trusted surface, if kernel behavior invalidates the hostile proof, or if an end-to-end execution design can remove this substrate without weakening the demonstrated boundary.
