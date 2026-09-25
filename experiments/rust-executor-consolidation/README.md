# Rust executor consolidation

## Question

Does the long-lived Go executor earn its production role as a bounded concurrent execution fabric once Rust owns per-attempt confinement, or can TypeScript dispatch directly to one-attempt Rust launchers without materially degrading saturated execution?

The original phase of this experiment asked a narrower question and is retained below as historical semantic evidence. It did not test the reason Go was introduced: high-throughput bounded concurrency, backpressure, cancellation, and low resource overhead across many already-authorized envelopes.

## Architectures under test

Control:

    TypeScript semantic authority
              |
              v
    long-lived Go execution fabric
              |
              v
       authorized process work

Candidate:

    TypeScript semantic authority
              |
              v
    bounded direct Rust attempts
              |
              v
       confined process work

This experiment decides whether Go can be deleted. It does not ask whether Rust is generally preferable to Go, and it does not move graph, claim, recovery-policy, provider, observation, or settlement authority out of TypeScript.

## Design provenance

**Preregistered.** The criteria below are committed before any hosted comparison result is accepted.

## Plausible contrast

Keep the current production split: the Go daemon remains the long-lived pure-computation executor and Rust remains a separate confinement substrate.

## Required semantic parity

The candidate must preserve the externally relevant `ComputationExecutor` contract for the tested corpus:

1. exact execution-capability and process-spec digest validation happens before process start;
2. success and nonzero-exit evidence remain bound to run, obligation, claimed revision, generation, execution-authority commit, capability digest, and spec digest;
3. stdout/stderr hashes cover the complete raw byte streams;
4. captured stdout/stderr prefixes obey the independent process-spec limits and report truncation exactly;
5. non-UTF-8 output survives evidence construction without replacement-character corruption;
6. relative working directories remain confined beneath the already-open workspace object and symlink/path escape fails closed;
7. explicit environment reconstruction is preserved;
8. timeout terminates the whole exact attempt containment domain;
9. detached descendants cannot survive an apparently completed attempt;
10. execution-context mismatch is rejected before claim rotation by the authority-side integration;
11. an interrupted attempt cannot be retried until prior containment termination is proven.

A mismatch in items 1-11 is a failed simplification unless it can be repaired without recreating a long-lived native daemon or weakening the existing authority boundary.

## Concurrent fabric measurements

**Phase 2 is preregistered before any hosted concurrent result is accepted.**

Both architectures receive the same bounded client-side admission and the same 4-CPU, 2 GiB, 4096-PID cgroup envelope. Concurrency 1 and 8 remain descriptive diagnostics. For the deletion-gated concurrency 32 and 128 cells, run **9 counterbalanced paired rounds** per profile, alternating Go-first and Rust-first order. Each round executes the full listed workload:

- 1,024 no-op jobs;
- 512 10 ms jobs;
- 256 100 ms jobs;
- 64 deterministic mixed jobs spanning no-op, 10 ms, 100 ms, and 1 s;
- a separate 20,000-attempt no-op retention stress at concurrency 64, matching the envelope count and concurrency of the original experiment that admitted Go. The 20,000 attempts are partitioned into **five counterbalanced paired 4,000-attempt blocks** per architecture so the scale stays fixed while runner-order uncertainty becomes measurable.

For every cell report aggregate throughput plus p50, p95, and p99 completion latency. For gated cells, compute within-round Go/Rust throughput ratios and Rust/Go p95 ratios, then use the upper one-sided 95% percentile-bootstrap bound of the median paired ratio for the deletion decision. The treatment uses 20,000 deterministic bootstrap resamples and never stops early. Separately run 64 jobs at concurrency 32 with one timeout/cancellation in every eight jobs, then prove both executors still accept ordinary work.

Peak memory is measured from fresh sibling cgroups containing only the competing execution architecture and its task descendants.

### Preregistered deletion gate

Concurrency 1 and 8 are diagnostic. At concurrency 32 and 128, direct Rust must satisfy both throughput and p95 limits:

- no-op and 10 ms: the **upper one-sided 95% bootstrap bound** for median paired Go throughput advantage and Rust/Go p95 ratio must each be <= 1.25x;
- 100 ms and mixed: the corresponding upper 95% bounds must each be <= 1.10x;
- for the five 4,000-attempt retention blocks, the upper 95% bound for median paired Go throughput advantage must be < 2.0x, so the 20,000-attempt concurrency-64 stress does not reproduce the original material >=2x Go advantage;
- Rust peak cgroup memory <= 1.25x Go peak cgroup memory;
- all expected concurrent cancellations complete with the correct outcome and both paths remain usable afterward.

The 20,000-attempt retention stress directly challenges the scale at which PR #66 originally earned Go a production role: 20,000 envelopes at concurrency 64, where the historical run measured 2.72x throughput and 13.37x lower RSS for Go. The new stress uses real current execution attempts rather than the old synthetic runner, so it is a retention test rather than a byte-for-byte reproduction. Its purpose is to falsify the claim that the Go fabric's previously measured scale advantage survives the current Rust confinement architecture.

These gates are intentionally stricter than the earlier language-selection experiment. The burden here is deletion of an already-evidenced concurrency component, not justification for adding a new language.

A negative gate result is a valid experimental result. Failure to exclude a material regression also counts as negative evidence for deletion: inconclusive non-inferiority is not treated as equivalence. It means Go still earns the execution-fabric role; it must not be hidden by the source-line reduction.

## Simplification criterion

Before deleting Go, the candidate cutover diff must demonstrate all of:

- removal of the production Go module and `.go-version`;
- removal of the Go toolchain from production/self-application CI;
- removal of the Unix-socket executor server/client and hello/command protocol;
- no replacement long-lived native queue, dispatcher, or duplicate lifecycle state;
- net deletion of production implementation machinery after the Rust adapter and any required recovery support are included.

If equivalent correctness requires rebuilding the Go daemon architecture in Rust, the hypothesis is falsified even if one toolchain disappears.

## Environment

- GitHub Actions `ubuntu-24.04`;
- exact Node version from `.node-version`;
- exact Go version from `.go-version` for the control;
- exact Rust version from `rust-toolchain.toml`;
- Linux cgroup v2 and Landlock support required by the maintained Rust proof.

## Reproduce

```sh
npm run experiment:rust-executor-consolidation
```

The hosted workflow is the reference environment for kernel confinement and resource evidence.

## Interpretation

A positive result supports deleting a redundant native execution architecture. It does not support moving Overcenter's semantic authority into Rust, nor does it establish that Rust is generally preferable to Go.


## Evidence status

### Phase 1: semantic and one-attempt viability

Evaluated at exact revision `e36e429ea03fc431772867a76bc4e50348eeeb02`, GitHub Actions run `35774841870`.

The phase remains useful evidence: all eight differential semantic cases passed, fresh-authority exact-cgroup recovery passed, and the Rust path exposed and repaired three real correctness gaps around relative cwd binding, raw-byte output, and descendant-held pipes.

Its latency results were:

| workload | Go | Rust candidate | Rust / Go |
| --- | ---: | ---: | ---: |
| no-op | 4.348 ms | 17.018 ms | 3.914x |
| 100 ms | 105.234 ms | 117.998 ms | 1.121x |
| 1 s | 1006.308 ms | 1019.007 ms | 1.013x |

Those measurements establish one-attempt semantic viability. They do **not** establish that the Go executor is redundant because the Go control was hard-coded to concurrency 1 and every benchmark was serial.

The earlier architectural conclusion is therefore withdrawn.

### Phase 2: concurrent execution fabric

**PENDING.** The executable experiment now measures the role for which Go was retained: sustained bounded concurrent work under saturation. No production cutover or Go deletion is supported unless the Phase 2 gates above pass at an exact hosted revision.


## Source-layout recut

The phase-2 treatment was mechanically recut after the repository moved the execution runtime under `src/execution/`. The hosted attempt at `631f5131a8804de3fa7a81f5e5a4c32ee281ca30` ended before measurement because the harness referenced the removed path `runtime/overcenter-exec/main.rs`.

The recut does not change the workload matrix, concurrency levels, thresholds, cancellation cases, or retention scale. The Rust corrections retained from phase 1 are explicit experiment-local treatment files, and the harness composes them with the current confinement entry point and resource module instead of resurrecting obsolete production paths.
