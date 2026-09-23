# Typed capability authority

## Question

Can Rust preserve the current GitHub commit-status mutation admission semantics while making weaker authority impossible to pass to the effect primitive through safe code, without materially reducing local admission performance?

This is an architectural experiment, not a production-boundary migration. Production authority remains TypeScript + SQLite while this experiment evaluates whether a Rust capability representation earns the cost of changing that boundary.

## Current control

The production path performs runtime validation in two places:

1. `src/providers/github/status-effect.ts` binds claimed work, effect contract, and postcondition to the presented execution permit.
2. `KernelCore.beginEffect` uses `projectExecutionAuthority` and `mutationAdmitted` to require the current execution generation, exact claimed revision, matching capability digest, an EXECUTING lifecycle, and no unresolved prior effect before durably reserving mutation.

Those checks remain authoritative runtime facts. The proposed representation does **not** attempt to prove remote or time-varying facts at compile time.

## Treatment

The Rust treatment performs the same runtime admission checks once and, on success, mints:

```rust
ExecutionPermit<'run, GithubCommitStatus>
```

The type has private fields, a sealed effect marker, no public constructor, and zero runtime payload. The effect primitive accepts only that capability and consumes it by value.

```text
raw run + claimed work + lifecycle + effect state
                    |
                    | authoritative runtime validation
                    v
       ExecutionPermit<GithubCommitStatus>
                    |
                    | move / consume
                    v
          GitHub status effect boundary
```

The aggregate capability is deliberate. The experiment does not expose separate `VerifiedRevision`, `Lease`, and `Authority` values that could later be recombined across different executions.

## Security differential

`experiment.rs` independently implements both:

- a structural baseline matching the current TypeScript admission order; and
- the typed capability treatment.

It exhaustively toggles 17 modeled conditions, covering **131,071 hostile combinations plus one valid control**:

- claimed-work obligation, run, and claimed-revision binding;
- explicit GitHub status effect grant;
- GitHub status postcondition kind;
- execution run and obligation identity;
- execution generation;
- execution-authority commit;
- stored and presented capability digests;
- claimed revision, claim commit, and obligation key;
- lifecycle run identity;
- EXECUTING lifecycle status;
- unresolved prior effect.

Every case must produce the same admission/error class in the baseline and treatment. Only the all-valid control may cross the effect boundary.

## Compile-fail controls

The harness also requires three programs to fail compilation for the intended reason:

- `negative-raw.rs`: a raw presented permit cannot be passed to the effect primitive;
- `negative-forge.rs`: safe caller code cannot construct an `ExecutionPermit` because its fields are private;
- `negative-reuse.rs`: a consumed permit cannot be used for a second effect.

These are properties the current structural TypeScript `ExecutionPermit` cannot express at compile time.

## Performance

The optimized Rust binary compares the baseline and typed treatment using alternating rounds and median wall-clock duration.

Two measurements are required:

- sequential admission: 2,000,000 successful admissions per round, seven rounds;
- concurrent admission: up to eight host threads, 1,000,000 admissions per thread per round, five rounds.

The treatment fails if median typed admission takes more than **1.10x** the corresponding baseline in either measurement.

The capability must also remain zero-sized and require no drop glue. The benchmark is intentionally local: provider I/O, SQLite reservation latency, and authoritative readback dominate different portions of the real transaction and are already measured by `production-latency`.

## Maintenance after evaluation

The 1.10x sequential/concurrent performance ceilings were acceptance criteria for the exact evaluated treatment at `637d15c0f7d29cf0aec9be6afc9cfc40a8d0ea06`. They are not permanent merge limits for unrelated future changes that merely cause this maintained experiment to rerun.

Current CI continues to enforce the security differential, compile-fail controls, zero-sized affine representation, and exact admission equivalence. It still measures and reports the historical performance differential, but exceeding 1.10x on a later hosted runner is observational by default.

Set `OVERCENTER_ENFORCE_HISTORICAL_TYPED_CAPABILITY=1` only when intentionally asking whether a later revision still satisfies the original preregistered performance gate. Reproducing the accepted scientific result exactly should use the evaluated revision above.

## Reproduce

Requires a stable Rust toolchain:

```sh
npm run test:typed-capability-authority
```

The hosted workflow installs stable Rust and runs both the repository experiment-contract verifier and this experiment.

## Success criteria

The hypothesis survives only if all of the following hold:

1. all 131,072 modeled security cases agree exactly between baseline and typed admission;
2. only the fully valid case can execute the modeled effect;
3. forging, raw-authority invocation, and permit reuse all fail compilation;
4. the capability representation is zero-sized and has no drop glue;
5. sequential median admission time is at most 1.10x baseline;
6. concurrent median admission time is at most 1.10x baseline.

A failure is useful evidence. In particular, performance failure means the representation is not admitted merely because the API looks cleaner.

## Interpretation

If the experiment passes, it establishes a narrow result: for the modeled commit-status authority gate, Rust can preserve the current runtime security decision while moving downstream proof-carrying structure into the type system at negligible local cost.

That would justify a second experiment against an actual Rust-owned production mutation boundary before changing Overcenter's architecture. It does **not** by itself justify moving durable authority, provider observation, settlement, or graph semantics from TypeScript into Rust.

## Non-claims

This experiment does not prove:

- that runtime lease/generation/revision checks can be deleted at the authoritative boundary;
- that a capability remains valid after external authority changes;
- that provider credentials become coordinate-scoped;
- that arbitrary provider effects can use one generic capability safely;
- that end-to-end transaction latency or distributed throughput improves;
- that Rust should replace the current TypeScript + SQLite authority path;
- that safe Rust types protect against `unsafe` code, process compromise, or a malicious trusted provider adapter.


## Result

The first hosted exact-head run **supported** the preregistered hypothesis at `637d15c0f7d29cf0aec9be6afc9cfc40a8d0ea06` (GitHub Actions run `35819335382`, Rust 1.98.1 on Ubuntu 24.04):

- security differential: PASS for 131,071 hostile authority combinations plus the valid control;
- sequential median: baseline 7.615123 ms, typed 7.229962 ms, ratio **0.949x**;
- concurrent median on 4 threads: baseline 7.634022 ms, typed 7.317384 ms, ratio **0.959x**;
- representation: zero-sized affine capability with no downstream raw-authority path;
- compile-fail controls: raw invocation, safe forgery, and permit reuse all rejected as preregistered.

Both performance ratios were below the preregistered 1.10x non-regression ceiling. The result supports proceeding to a second experiment at an actual Rust-owned mutation boundary; it does not change the current production authority boundary.
