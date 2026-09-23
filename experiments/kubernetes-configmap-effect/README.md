# Kubernetes ConfigMap effect genericity

## Question

Can a second provider mutation use Overcenter's existing semantic-intent, claim/fence,
durable effect reservation, authoritative observation, and settlement machinery without
introducing Kubernetes-shaped logic into the kernel?

This is an experiment, not a production Kubernetes mutation adapter.

## Preregistered hypothesis

For the existing `kubernetes-configmap-exists/v1` postcondition, an experiment-local
ConfigMap ensure broker can perform this flow:

```text
semantic ensure
    ↓
claim / exact execution fence
    ↓
durable generic effect reservation
    ↓
PATCH ConfigMap
    ↓
crash / timeout / conflict cases
    ↓
authoritative LIST + WATCH continuity rules
    ↓
DONE or RECOVERY_REQUIRED
```

without changing the kernel or teaching generic settlement about UID,
`resourceVersion`, LIST pagination, WATCH continuity, or Kubernetes error codes.

## Falsifiers

The hypothesis is falsified if any of these occur:

- timeout-after-commit requires blind replay to reach DONE;
- a delete/recreate cycle carries the old UID forward as if object identity were unchanged;
- a resourceVersion conflict is treated by transport outcome alone rather than fresh provider state;
- broken WATCH continuity can extend an old absence certificate;
- authoritative absence with an unresolved reservation permits another PATCH attempt;
- the experiment needs a Kubernetes branch or special recovery state in the kernel;
- a successful PATCH settles DONE without authoritative provider observation.

## Cases

1. Ordinary ensure reserves before PATCH and reaches DONE only after fresh LIST observes the target.
2. Timeout after commit leaves the reservation unresolved, enters recovery, then fresh LIST settles DONE without a second PATCH.
3. Delete/recreate after an ambiguous commit changes UID; settlement observes the replacement UID rather than preserving stale identity.
4. A resourceVersion conflict remains non-authoritative; if a concurrent actor has already created the desired object, fresh LIST may settle DONE.
5. Failure before commit still remains ambiguous because Kubernetes has no admitted NOT_DISPATCHED release rule. Broken WATCH continuity cannot preserve old absence, a fresh absent relist remains RECOVERY_REQUIRED, and an attempted retry issues zero additional PATCHes.
6. The experiment asserts that the generic authority engine contains no Kubernetes-specific code.

## Boundary

The semantic effect contract and mutator live only inside this experiment. They deliberately
do not register `kubernetes.configmap` in the production semantic registry or trusted
dispatcher. The experiment mints generic `EffectAuthority` with `authorizeEffect` and crosses the private reservation boundary only through `performEffect`.

If the experiment is supported, promotion should be a separate change that binds the same
shape through production `EffectAuthority`, the trusted effect dispatcher, and a real
Kubernetes transport. Replay and reservation release should remain forbidden until separately
proved.

## Reproduce

```sh
npm run test:kubernetes-configmap-effect
```

The deterministic harness injects provider outcomes while exercising the production SQLite
kernel and the production Kubernetes LIST/WATCH certificate implementation.

## Non-claims

This experiment does not establish:

- that a production Kubernetes credential/RBAC boundary is correctly scoped;
- transport-level proof of whether bytes reached a real API server;
- safe automatic replay of Kubernetes mutations;
- a trusted NOT_DISPATCHED release rule for Kubernetes;
- ConfigMap data equality, server-side apply ownership, or arbitrary Kubernetes resources;
- production registration of Kubernetes as provider mutation #2.

## Developmental evidence

The first hosted exact-head candidate reached the retry case and failed only because the
test oracle expected `UNRESOLVED_EFFECT`. The generic kernel rejected the retry one fence
earlier with `RUN_NOT_EXECUTING`; zero additional PATCHes were issued and the unresolved
reservation remained intact. The oracle was corrected to accept either generic blocker
without changing the preregistered property: an ambiguous attempt must not mutate again.

## Prior result

The preregistered result was supported before the authority-seal restack at exact revision `1bcce9df74b40875797ac4f1fd4441b578da4f27` by
GitHub Actions merge-gate run 35924763601, attempt 2, candidate-evidence job
107397697533.

Observed treatment results:

- ordinary ensure: one PATCH, UID `uid-1`, resourceVersion `101`, then `DONE`;
- timeout-after-commit: one PATCH total, fresh authoritative LIST recovered `DONE`;
- delete/recreate: original UID `uid-1`, replacement UID `uid-2`, settlement observed `uid-2`;
- resourceVersion conflict: one PATCH attempt; fresh provider state, not the 409, established `DONE`;
- stale WATCH: prior absence was not carried;
- retry after ambiguous absence: zero additional PATCHes, blocked before provider I/O, final state remained `RECOVERY_REQUIRED`;
- kernel provider special cases: zero.

The same exact-head candidate also passed repository typechecking, deterministic regressions,
TLA+, the production computation boundary, and self-application.


## Authority-seal recut

The maintained experiment now runs on #315's sealed mutation topology:

```text
ExecutionPermit
    ↓ authorizeEffect
EffectAuthority
    ↓ performEffect
private durable reservation
    ↓
experiment-local ConfigMap PATCH
```

Kubernetes remains absent from the production semantic registry and trusted dispatcher in this experiment. Exact-head recertification of this recut is required before promotion evidence is refreshed.
