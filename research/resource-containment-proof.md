# Resource containment proof

Overcenter's resource-containment claim is narrower than "the worker runs in a cgroup."

The supported claim is:

> One uncertain worker attempt is bound to one exact kernel resource domain; its descendants cannot exceed the admitted CPU, memory, and PID envelope; final resource evidence is sampled only after that exact domain is empty; and the aggregate delegated worker pool is itself bounded.

This claim is split across deterministic implementation checks, a small formal supervisor model, and a hostile Linux proof. No one layer substitutes for the others.

## Invariant 1: exact resource-object authority

An attempt owns one host-created cgroup-v2 leaf.

Authority is the pinned kernel object, not:

- a PID;
- a process-group ID;
- a cgroup name;
- a reusable pathname.

The trusted supervisor creates a fresh leaf, opens it, records device/inode identity, and passes that exact leaf on FD 4. Rust configures and enters FD 4. After worker execution, termination, evidence, identity verification, and removal stay bound to the supervisor's pinned leaf object.

An unrelated stale leaf is therefore not a valid termination or evidence target.

**Witnesses**

- implementation: `src/confined-executor.ts`, `runtime/overcenter-exec/resource.rs`;
- formal: `formal/ResourceContainment.tla` invariant `ExactLeafAuthority`;
- negative control: `formal/BrokenResourceIdentity.cfg`;
- hostile proof: an unrelated stale leaf survives another launch untouched.

## Invariant 2: final evidence follows descendant death

Direct-child exit is not enough to make resource evidence final because detached descendants may still exist.

The admitted ordering is:

```text
direct child closes
        |
cgroup.kill exact leaf
        |
wait for cgroup.events populated=0
        |
verify exact resource policy
        |
read final counters
        |
verify leaf device/inode
        |
remove empty leaf
```

Evidence sampled before `populated=0` is operational telemetry, not final attempt evidence.

**Witnesses**

- implementation: finalization in `src/confined-executor.ts`;
- formal: `FinalEvidenceSafety` and `RemovalSafety`;
- negative control: `formal/BrokenResourceEarlyEvidence.cfg`;
- hostile proof: timeout/output termination and descendant cleanup leave no attempt leaf behind.

## Invariant 3: containment exists at attempt and aggregate levels

A finite child cgroup does not by itself protect the host from many concurrent or stranded attempts.

The direct delegated parent must therefore be a finite aggregate worker pool:

- finite `memory.max`;
- finite `pids.max`;
- finite `cpu.max`;
- `cpu.max.burst = 0`;
- finite `cgroup.max.descendants`;
- `cgroup.max.depth = 1`;
- `cpu`, `memory`, and `pids` delegated to children.

Each manifest then defines the smaller per-attempt child ceiling.

The child values are ceilings, not capacity reservations. Ancestors may be tighter.

A supervisor crash may leave a bounded orphan leaf. This layer does not guess whether that leaf is stale and kill it blindly. The finite descendant budget bounds accumulation until authority-aware recovery decides what to do.

**Witnesses**

- deterministic parent-contract validation in `src/confined-executor.ts`;
- real delegated hierarchy constructed by `runtime/overcenter-exec/proof.sh`;
- kernel enforcement probes for PID exhaustion, CPU throttling, and memory OOM.

The TLA+ resource model does not prove Linux aggregate accounting. That remains a physical host/kernel claim.

## Invariant 4: declared resource policy matches enforceable kernel policy

The execution manifest binds:

- `memory_max_bytes`;
- `pids_max`;
- `cpu_quota_us`;
- `cpu_period_us`;
- `timeout_ms`;
- `max_output_bytes`.

Changing any value changes execution identity.

Rust writes and reads back the cgroup controls before untrusted code runs. The resource boundary also closes kernel-specific gaps that would make the plain manifest wording misleading:

- swap is disabled for the attempt;
- OOM handling is group-scoped;
- CPU burst is forced to zero;
- inherited realtime/deadline scheduling classes are rejected because `cpu.max` governs fair-class bandwidth rather than those classes;
- `MAP_HUGETLB`, `MFD_HUGETLB`, and System V shared-memory allocation paths are denied so HugeTLB cannot become a host-dependent memory-accounting escape.

**Witnesses**

- canonical manifest tests in `test/execution-manifest.test.ts`;
- Rust parser/configuration in `runtime/overcenter-exec/manifest.rs` and `resource.rs`;
- hostile probes in `runtime/overcenter-exec/hostile_worker.rs` and `resource_probe.rs`;
- hosted real-cgroup proof.

## Invariant 5: trusted containment machinery is itself bounded

Moving authority out of the worker is insufficient if the trusted supervisor can be exhausted by worker-controlled output or can strand an unbounded number of kernel objects.

The supervisor therefore has:

- a manifest-bound output limit;
- an unconditional 64 MiB combined stdout/stderr implementation ceiling;
- manifest-bound wall-clock timeout;
- exact-leaf whole-tree termination;
- bounded cgroup hierarchy growth through the finite parent contract.

Cleanup failure is an execution failure, never silent success.

**Witnesses**

- `src/execution-manifest.ts` and `runtime/overcenter-exec/manifest.rs`;
- deterministic output-ceiling and invalid-parent tests;
- real supervisor timeout/output-overflow proof under cgroup v2.

## Evidence matrix

| Claim | Deterministic implementation | Formal model | Hostile real-kernel proof |
| --- | --- | --- | --- |
| exact leaf owns termination/evidence/removal | yes | `ExactLeafAuthority` | stale-leaf noninterference |
| evidence is final only after descendants are gone | supervisor finalization tests/contracts | `FinalEvidenceSafety`, `RemovalSafety` | whole-tree kill + empty-leaf cleanup |
| per-attempt PID ceiling | manifest/parser contract | not modeled | fork until `EAGAIN`, inspect `pids.events` |
| per-attempt CPU ceiling | manifest/parser/scheduler-class contract | not modeled | sustained CPU work, inspect throttling |
| per-attempt memory ceiling | manifest/parser/HugeTLB policy | not modeled | allocation pressure, inspect OOM kill |
| aggregate worker-pool bound | parent preflight | not modeled | real finite delegated parent |
| trusted output bound | canonical input validation | not modeled | output-overflow supervisor proof |

## How to reproduce

The deterministic suite includes the manifest and trusted-transport contracts:

```sh
npm test
```

The model checker proves the supervisor protocol and requires both broken resource configurations to produce the expected counterexamples:

```sh
npm run proof:formal
```

The supported production proof compiles the Rust boundary and exercises a real cgroup-v2 hierarchy:

```sh
npm run proof:production
```

The focused kernel proof is:

```sh
npm run proof:rust-exec
```

## What this does not prove

This resource boundary does not currently claim:

- device-specific I/O throttling;
- workspace disk quotas;
- complete VM-style isolation;
- pathname metadata confidentiality;
- advisory-lock isolation on explicitly granted files;
- automatic authority-safe cleanup of orphan leaves after supervisor death;
- guaranteed capacity equal to a manifest ceiling;
- a global trusted-supervisor memory bound across arbitrary concurrent attempts.

Those remain separate design obligations rather than conclusions inferred from cgroup membership.
