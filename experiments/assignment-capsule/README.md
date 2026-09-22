# Assignment capsule plumbing proof

## Question

Can Overcenter claim a real obligation, hand a disposable worker that exact assignment plus every task-specific byte required to act on it, and later settle the result without giving the worker repository access, network access, or an execution capability?

## Claim and contrast

The hosted proof uses the production SQLite kernel to derive READY work and claim it at an exact revision. Trusted authority then emits one immutable assignment capsule containing:

- the claimed `Work` snapshot, including obligation, run, and claimed revision;
- the exact source revision as provenance;
- every task-specific input byte, each with path, mode, and SHA-256;
- the worker command and declared output path;
- the reusable `src/assignment-capsule.ts` verifier/runner.

The worker job performs **no checkout**, receives **no repository permission**, runs the assignment inside a separate network namespace, and receives no `ExecutionPermit`. It can produce only candidate output bytes bound to the assignment digest and claimed run. Trusted settlement reopens the durable SQLite authority, validates that binding, independently observes the candidate under the original postcondition, and settles the same run.

The contrast is the current self-application/disposable-agent pattern in which a worker receives an exact identity but obtains source bytes through an ambient checkout or mount.

## Fail-closed controls

The deterministic contract and hosted worker prove that:

- changing one delivered byte without changing its digest is rejected before materialization;
- deleting one required file is rejected before execution;
- hostile paths and duplicate/malformed capsule structure are rejected;
- workspace materialization contains only declared files;
- the worker sees no execution capability;
- candidate bytes are bound to the exact assignment digest, obligation, run, and claimed revision;
- the task process receives no `GITHUB_TOKEN` and cannot establish an outbound TCP connection from its network namespace.

## Run

```sh
npm run test:assignment-capsule
gh workflow run assignment-capsule-proof.yml
```

## Interpretation

A passing hosted proof establishes the missing transport statement for this bounded workload:

```text
Overcenter READY selection
        ↓
exact claim
        ↓
self-contained assignment capsule
        ↓
empty disposable worker
        ↓
candidate bytes
        ↓
trusted observation + settlement
```

The task-specific bytes are self-contained. The reusable capsule mechanism lives in `src/`; this experiment only exercises it. The Node runtime and Linux kernel remain trusted execution substrate and are not embedded in the assignment.

## Non-claims

This does not establish a general artifact distribution service, arbitrary toolchain portability, confidential payload transport, provider mutation authority, or that every future obligation can be represented by the proof packet. It also does not make the candidate worker authoritative for success; settlement remains an independent deterministic decision.
