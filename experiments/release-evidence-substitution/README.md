# Release evidence substitution

## Question

Can a conventional Temporal/Kubernetes-style release workflow falsely attribute a
healthy current Deployment to the wrong execution even when it checks the obvious
distributed-systems coordinates, while an exact Overcenter-style evidence binding
rejects the same observation?

The target claim is deliberately stronger than "the desired image is running":

> Git commit A was realized by the exact authorized deployment effect for A, and
> the resulting workload is healthy.

## Why this is a useful adversary

The dangerous schedule uses two releases with the **same image digest**. That is
not exotic: two commits can legitimately build identical runtime bytes.

```text
release A / run A
  Kubernetes accepts mutation
  response is lost
           |
           v
release B / run B
  same Deployment coordinate
  same image digest
  delete + recreate
  healthy
           |
           v
A recovery observes B's object
```

A conventional recovery check can be quite careful and still accept the wrong
realization if it checks:

- cluster / namespace / Deployment name;
- immutable image digest;
- generation versus observedGeneration;
- ready replicas;

but does not bind the observation to the exact authorized effect identity.

That is the initial hostile mutant. The point is not that Temporal or Kubernetes
cannot implement the stronger rule. They can. The question is how much
application-specific identity, retry, recovery, and evidence plumbing is required
to do so reliably.

## Two implementations

### Conventional baseline

The deterministic model represents the application-level correctness logic that
would sit around Temporal Activities and Kubernetes reconciliation. Its initial
baseline is intentionally **competent but incomplete**: exact coordinates, digest,
generation, and health are all checked.

The hosted phase must replace this model with a real Temporal worker and kind
cluster before the experiment may claim a complexity win.

### Overcenter candidate

The candidate uses the production `realizationObligationKey()` function to bind
the semantic release intent and adds an experiment-local external-effect identity:

```text
obligation key
    +
run identity
    |
    v
effect identity
    |
    v
Kubernetes object annotation
    |
    v
certified observation
    |
    v
settlement
```

The observation must prove both the release obligation and the exact effect. A
later healthy object belonging to another run is therefore valid Kubernetes
evidence but invalid evidence for the proposition being settled.

This experiment-local binding is **not production authority**. If it wins, the
production boundary still needs an explicit design and proof before adoption.

## Pre-registered hostile schedule

The deterministic phase executes this schedule:

1. release A targets commit A and image digest D;
2. run A receives an exact effect identity;
3. Kubernetes accepts A's write, but the Activity response is lost;
4. release B targets commit B but the same digest D;
5. B deletes/recreates the Deployment at the same coordinate;
6. B becomes fully healthy with generation == observedGeneration;
7. A performs recovery from current provider state;
8. the conventional baseline must demonstrate whether it can misattribute B to A;
9. exact evidence binding must reject B's observation for A;
10. a hostile verifier mutant that drops only the effect-identity check must be
    killed by a same-obligation/different-run variant.

## Success criteria

The experiment does **not** count as a win until all of these are true:

1. **Real conventional implementation.** A Temporal worker and a real kind
   cluster reproduce the schedule without relying on the deterministic model for
   the result.
2. **Fair baseline.** The conventional implementation uses normal good practice:
   immutable digests, idempotent Activity design, exact Kubernetes coordinates,
   generation/readiness checks, and durable workflow state. No intentionally
   naive baseline is allowed.
3. **Material simplification.** The Overcenter application path owns
   substantially fewer release-specific identity joins, recovery branches, and
   durable coordination states. Report both application-specific code and total
   reusable-framework code; do not hide framework complexity.
4. **Real false attribution.** At least one plausible omission in the conventional
   implementation permits A to be marked successful from B's healthy realization.
5. **General invariant catches it.** Overcenter rejects that observation because
   a reusable identity/evidence invariant fails, not because the test recognizes
   this particular scenario.
6. **Mutation proof.** Removing exactly one material binding from the
   Overcenter verifier causes the hostile schedule to survive, and the mutation
   probe kills it.
7. **No safety regression.** Ambiguous mutation outcomes never authorize blind
   replay, and a stale or unrelated healthy object never authorizes settlement.

## Metrics

The hosted comparison must report at least:

| Metric | Conventional | Overcenter |
| --- | ---: | ---: |
| application-owned durable states | pending | pending |
| application-owned recovery branches | pending | pending |
| application-authored identity joins | pending | pending |
| application LOC for release correctness | pending | pending |
| reusable framework LOC touched | pending | pending |
| false settlements under fault matrix | pending | pending |
| surviving single-binding mutants | pending | pending |

LOC is supporting evidence, not the conclusion. The primary simplification
measurement is how much correctness machinery the application itself must own.

## Current deterministic witness

Run:

```sh
npm run test:release-evidence-substitution
```

The current witness is allowed to establish only:

- the proposed fault schedule is internally coherent;
- a careful but effect-unbound recovery predicate can falsely settle A;
- an exact obligation/effect binding rejects the substituted observation;
- the run-level effect binding is independently necessary under a
  same-obligation/different-run substitution.

It does **not** establish the full three-part killer example yet.

## Hosted phase

The next phase should use:

- Temporal server + TypeScript SDK;
- a disposable kind cluster;
- a Deployment annotated with deterministic obligation/effect identities;
- a fault injector that drops the Activity response after Kubernetes accepts A;
- a second workflow that deletes/recreates the Deployment for B;
- independent GitHub-status publication only after each implementation's
  settlement predicate returns true.

The hosted run should be manually dispatchable while the experiment is unstable
so it does not lengthen ordinary CI.

## Interpretation

A positive final result would support the narrower claim that exact
execution/evidence identity can move a recurring class of cross-system
correctness bookkeeping out of release-application code while catching a
plausible false-attribution bug.

A negative result is equally useful. In particular, if a good conventional
implementation is comparably small, or if Overcenter needs similar bespoke
plumbing, the experiment should say so.

## Non-claims

This experiment does not prove that:

- Temporal or Kubernetes are unsafe;
- Temporal cannot express the required identity and recovery discipline;
- Overcenter currently has production-ready Deployment realization binding;
- identical image bytes necessarily mean identical release provenance;
- fewer lines of application code alone imply a better architecture;
- the deterministic model is a substitute for the hosted comparison.
