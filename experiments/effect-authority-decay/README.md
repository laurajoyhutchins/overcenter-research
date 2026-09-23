# Effect authority decay

## Question

Once Overcenter has established execution authority, can it preserve that fact through the trusted GitHub effect broker instead of decomposing it back into raw run/revision fields and reconstructing the same relationship in each provider?

Evaluated baseline: `81b350e526824ab2c397642e6761a0c860151331`.

This is the production-path follow-on to the earlier typed-capability work. It deliberately targets **authority decay**, not the runtime checks that establish mutable external truth.

## Baseline

Both admitted GitHub mutation providers independently:

1. reconstruct claim-time work from a raw `ExecutionPermit`;
2. compare obligation id, run id, and claimed revision;
3. check the effect contract;
4. check the postcondition verifier;
5. later pass the raw permit to `performEffect`.

`reserveEffect` then performs the independent current-head execution-generation, exact-revision, lifecycle, capability-digest, and unresolved-effect fence. That final fence is necessary because authority may change during provider I/O.

## Treatment

`KernelCore.authorizeEffect` binds the raw permit to historical claimed work once and returns:

```ts
EffectAuthority<effectContract, verifier>
```

The authority is nominally branded with a module-private `unique symbol`, carries the exact permit and narrowed postcondition, and is the only input accepted by `performEffect`.

The existing `claimedWork(runId)` behavior remains available for project submission, which legitimately reconstructs exact historical assignment bytes.

```text
runtime claim authority
        │
        ▼
 authorizeEffect
        │
        ▼
 EffectAuthority<effect, verifier>
        │
        ├── provider identity observation
        │
        ▼
 performEffect
        │
        ▼
 reserveEffect current-head fence
        │
        ▼
 consequential provider mutation
```

## Compile-time claim

The repository's production TypeScript checker is part of the experiment. `test/effect-authority-types.ts` uses `@ts-expect-error` controls to require both of these to remain impossible:

- passing a raw `ExecutionPermit` to `performEffect`;
- structurally forging an `EffectAuthority` outside the authority module.

If either invalid program becomes type-correct, `npm run typecheck` fails.

## Critical race

The runtime adversary mints bound authority, supersedes the execution generation during asynchronous provider identity observation, then reaches the mutation boundary.

The unchanged `reserveEffect` fence must reject `STALE_EXECUTION_GENERATION` before POST and before creating an unresolved effect reservation.

That is the intended split:

> Runtime authority establishes truth; typed interiors preserve established truth; mutable external authority is fenced again immediately before the consequential effect.

## Measurements

The current-main comparison records:

- provider claim-work reconstruction sites;
- provider raw work/permit coordinate comparisons;
- provider effect-contract checks;
- provider verifier checks;
- provider calls of `performEffect(rawPermit,...)`;
- one centralized authority-mint site;
- combined nonblank SLOC across the authority engine and both admitted GitHub mutation providers;
- existing GitHub provider-effect regressions;
- the full production TypeScript typecheck;
- same-runner production latency against the exact baseline.

Latency uses three alternating baseline/treatment runs on one hosted runner. Median-of-run medians for `effect_reservation_ms` and `overcenter_local_ms` must each stay at or below **1.10x** baseline.

## Success criterion

The hypothesis is supported only if all of these hold:

- raw permit/work mismatch fails before provider I/O;
- authority superseded after binding fails at the final runtime fence before mutation;
- production typecheck proves raw permits and forged authorities cannot reach the typed effect boundary;
- duplicated provider reconstruction/check sites fall to zero, with exactly one centralized authority mint;
- combined production SLOC does not increase;
- existing provider-effect regressions pass;
- same-runner local latency remains within 1.10x baseline.

The final runtime fence is not eligible for deletion.

## Maintenance after evaluation

The SLOC and fixed-baseline latency thresholds above were acceptance criteria for the evaluated treatment, and the exact supported result remains bound to revision `04bc98a42f4db5ddc73293a713412f17127fbc68`. They are not permanent limits on unrelated future authority-engine work.

Current CI keeps the safety-relevant regression criteria authoritative: the hostile runtime controls, TypeScript boundary, removal of duplicated provider authority reconstruction, provider regressions, and the single centralized authority mint. It continues to report SLOC and same-runner latency against the historical baseline for visibility, but those historical differential metrics do not veto a later change merely because the trusted engine grows or hosted-runner timing drifts.

To reproduce the original experiment acceptance exactly, check out the evaluated revision. On later revisions, set `OVERCENTER_ENFORCE_HISTORICAL_EFFECT_AUTHORITY_DECAY=1` only when intentionally asking whether that later revision still satisfies the old latency gate.

## Reproduce

```sh
npm install --ignore-scripts --package-lock=false
npm run test:effect-authority-decay
npm run bench:effect-authority-decay
```

## Provenance

An earlier prototype against an older main revision found focused support, then the broad merge gate exposed two legitimate consumers outside the provider tests: historical `claimedWork` reconstruction in `project.submit`, and a low-level reservation test. The current treatment preserves those semantics.

Accordingly, this current-main run is a **confirmatory replication of the corrected design**, not a claim that the treatment was chosen without prior observations.

## Non-claims

This experiment does not claim that:

- TypeScript branding provides Rust ownership or affine semantics;
- a bound authority remains current after external state changes;
- the final current-head reservation fence can be removed;
- provider identity observation or authoritative readback can be skipped;
- wire protocols can trust in-process types instead of validating received data;
- malicious trusted code or explicit unsafe casts are prevented.


## Result

The corrected current-main treatment is **supported** at exact production revision `04bc98a42f4db5ddc73293a713412f17127fbc68`.

Hosted evidence:

- effect-authority experiment run `35825868462`, job `107067328128`: all type, security, structure, provider-regression, and same-runner latency criteria passed;
- merge-gate run `35825868706`, candidate-evidence job `107067329353`: repository typecheck and the full deterministic regression passed on the same treatment head.

Authority-decay measurements:

- provider `claimedWork(permit.id)` calls: **2 -> 0**;
- provider raw work/permit coordinate comparisons: **6 -> 0**;
- provider effect-contract checks: **2 -> 0**;
- provider verifier checks: **2 -> 0**;
- provider `performEffect(rawPermit,...)` calls: **2 -> 0**;
- centralized authority mint sites: **1**;
- combined nonblank SLOC across the authority engine and two admitted GitHub mutation providers: **909 -> 907**.

Same-runner production latency, median-of-run medians:

- effect reservation: **0.718 ms -> 0.726 ms**, ratio **1.011x**;
- Overcenter local total: **4.430 ms -> 4.324 ms**, ratio **0.976x**.

Both remain comfortably within the preregistered **1.10x** ceiling.

The stale-authority adversary also passed: authority was bound, the execution generation was superseded during provider identity I/O, and the unchanged final `reserveEffect` fence rejected the old authority before POST and before effect reservation.

### Interpretation

This is the positive case the earlier experiments were trying to isolate.

The capability is useful **after** runtime truth has been established, specifically where that truth would otherwise decay into raw identifiers and repeated interior checks. It is not useful as a replacement for the external-state proof itself.

```text
runtime proof
    │
    ▼
bound authority
    │
    ├── trusted interior carries it
    │
    ▼
final mutable-state fence
    │
    ▼
effect
```

The historical `claimedWork(runId)` reconstruction API remains because `project.submit` has a real need to reconstruct exact assignment bytes. The treatment removes duplication only from the provider mutation path.
