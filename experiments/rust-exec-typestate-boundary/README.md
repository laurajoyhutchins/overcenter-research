# Rust exec typestate boundary

## Question

Can the typed-capability result from `typed-capability-authority` simplify a **real Rust-owned consequential boundary**, rather than merely make an isolated authority API prettier?

The production target is `src/execution/confinement/sandbox.rs`. This is the trusted Linux launcher that eventually calls `Command::exec()` after runtime proof of caller privilege state, exact cgroup entry, exact workspace identity, Landlock policy, execution-closure immutability, inherited-FD closure, and seccomp policy.

Baseline revision: `b683a84d55bb29b166652f00fa8b6be5f2aaec2c`.

## Treatment

The treatment changes the actual production launcher. The runtime sealing sequence now returns:

```rust
ExecPermit<'a>
```

The permit privately carries the exact `Manifest` reference plus the observed Landlock ABI. Its fields are private, and `launch(self)` consumes it. Therefore safe caller code cannot:

- manufacture permission to cross the final `exec` boundary;
- invoke the typed launch boundary from a raw manifest;
- reuse one permit for a second launch.

The permit is minted only after all existing runtime checks and kernel restrictions have succeeded.

## Why this experiment is stricter than the first one

A type-level gate is not automatically an architectural improvement. The existing Rust launcher is already a single straight-line fail-closed function. Its runtime checks establish facts about Linux state that the compiler cannot know.

The hypothesis is therefore **not** “typestate can be added.” It is:

> Typestate can make premature execution unrepresentable **and** allow real production runtime machinery to be deleted or consolidated without weakening physical confinement or materially increasing compiled footprint.

If it only adds a token while every dynamic check remains necessary, the hypothesis is falsified.

## Preregistered measurements

The experiment records four independent observations.

1. **Physical semantics:** the complete existing `src/execution/confinement/proof.sh` must pass against the treatment.
2. **Compile-time exclusion:** attempts to forge `ExecPermit` or reuse one after `launch(self)` must fail compilation for the intended reason.
3. **Runtime-defense census:** the treatment must reduce the set of explicit runtime guard classes present in `sandbox.rs`, relative to `b683a84d55bb29b166652f00fa8b6be5f2aaec2c`.
4. **Complexity/footprint:** nonblank production SLOC must not increase, and the optimized stripped launcher binary must not grow by more than 1%.

The guard census tracks the existing dynamic proof classes: caller privilege, cgroup entry, workspace identity, Landlock ABI/rights/ruleset, workspace/program/runtime rules, `fchdir`, Landlock restriction, inherited-FD closure, and seccomp installation.

## Success criterion

The architectural hypothesis is supported only if **all** of the following are true:

- the existing hostile physical-confinement proof still passes;
- both compile-fail controls reject invalid authority;
- at least one existing runtime guard class can be removed or consolidated;
- production `sandbox.rs` nonblank SLOC is no greater than baseline;
- optimized stripped launcher size is no more than 1% above baseline.

A green workflow with `hypothesis=FALSIFIED` is a valid negative experiment. Workflow success means the experiment executed correctly, not that the treatment won.

## Reproduce

```sh
npm run test:rust-exec-typestate-boundary
npm run proof:rust-exec
```

The first command evaluates compile-time exclusion, source complexity, guard census, and optimized binary footprint. The second exercises the actual kernel boundary.

## Interpretation

A supported result would justify keeping the treatment and considering the same pattern at other Rust-owned consequential boundaries.

A falsified result would establish a useful limit: at this boundary, the runtime checks are proofs of external state, not bookkeeping that Rust's type system can replace. In that case the production treatment should be reverted, while this exact-revision negative result is retained as evidence.

## Non-claims

This experiment does not claim that:

- Linux runtime facts can be proven statically;
- the TypeScript supervisor's independent workspace/cgroup checks are redundant;
- Rust typestate replaces exact FD identity or cgroup readback;
- provider mutation authority belongs in the confinement launcher;
- safe Rust prevents a malicious change inside the trusted `sandbox` module itself;
- binary size alone is an end-to-end latency benchmark.
