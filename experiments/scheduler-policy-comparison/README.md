# Scheduler policy comparison

## Question

After #320 demonstrated that the current fresh-first rule can starve recovered work under continual fresh admission, what is the smallest deterministic policy that survives both cross-class and same-class starvation attacks?

The experiment compares four policies without changing production scheduling.

| Policy | Rule |
| --- | --- |
| current fresh-first | never-claimed identities outrank previously claimed identities; then least recent claim |
| recovered-first | previously claimed identities always outrank never-claimed identities |
| class alternation | alternate fresh/recovered when both classes are present |
| service age | choose the smallest durable service age: admission ordinal before first claim, last-claim ordinal afterward |

Service age is deliberately not a wall-clock age. It is an ordinal derived from the existing append-only authority history.

## Hostile scenarios

Each policy is tested at simulated concurrency 1, 2, and 4.

### Recovered target under continual fresh admission

A target has already been claimed once and returned to READY. Before every scheduling wave, enough never-claimed work arrives to fill the whole wave.

This reproduces #320's open-system starvation boundary.

### Fresh target under perpetual recovery pressure

A recovered identity remains READY forever by returning to READY after every claim. A fresh target is then admitted.

This falsifies a naive recovered-first repair if fresh work can be starved forever.

### Older fresh target under continual younger same-class arrivals

Four fresh obligations and then the target are admitted. Before every wave, lexicographically earlier fresh IDs are added.

This attacks class-level fairness. A scheduler that merely alternates fresh/recovered can still starve one identity inside the fresh class.

## Candidate invariant

For service age, fix any continuously eligible target.

At the instant it becomes continuously eligible, only finitely many eligible identities can have a smaller service age. Every time one of those older identities is selected, its service age moves to the new claim ordinal, which is younger than the target. Work admitted later is also younger than the target.

Therefore the set of eligible identities older than the target can only decrease.

That is the property modeled independently in `formal/SchedulerServiceAge.tla`.

## Formal negative control

`BrokenServiceAgeNonMonotone.cfg` deliberately allows later work to mint an age older than the target. TLC must then find a temporal starvation trace. This tests the exact assumption on which the service-age argument depends rather than assuming universal progress.

## Reproduce

```sh
npm run experiment:scheduler-policy-comparison
npm run proof:formal
```

## Promotion boundary

Even if service age wins, this experiment does not change `deriveProjectProjection()`.

Production promotion would first need to carry each current obligation's first binding/admission ordinal from durable graph-patch replay into the scheduler projection. That is reconstructible metadata, not a new authority fact or scheduler cursor.


## Exact-head result

Evaluated revision: `32ad84f3bddbc62a95207e33bc23f1a0c65f35b6`

GitHub Actions: Merge gate run `35925767660`, exact-head candidate job `107400938453`.

The preregistered policy matrix was stable across simulated concurrency widths 1, 2, and 4:

| Policy | Recovered target + fresh flood | Fresh target + recovery pressure | Older fresh target + younger fresh flood |
| --- | ---: | ---: | ---: |
| current fresh-first | starved | claim 1 | starved |
| recovered-first | claim 1 | starved | starved |
| class alternation | claim 1 | claim 2 | starved |
| service age | claim 1 | claim 2 | claim 5 |

The service-age result is width-independent in these workloads because width changes how many selection opportunities occur per wave, not the ordinal ordering itself.

### Formal result

`SchedulerServiceAge.cfg` passed TLC. Its model allows arbitrarily continuing younger admissions while a continuously eligible target waits behind a finite older set.

`BrokenServiceAgeNonMonotone.cfg` produced the required temporal counterexample when later work was permitted to increase the set older than the target.

This isolates the essential assumption:

```text
later admission / later claim
        => younger service age
```

Under that ordering, every claim of an identity older than the target moves that identity behind the target, and newly admitted identities cannot jump ahead. The finite older set therefore drains.

### Production implication

The experiment does **not** require a scheduler cursor or a new authority fact.

It does require one piece of derived projection metadata that production does not currently retain: the first durable binding/admission ordinal for each current obligation. Claim order already exists in durable run order. A production implementation could therefore derive:

```text
service_age(identity) =
  last current claim ordinal
  OR, if never claimed,
  first current binding ordinal
```

and select the READY identity with the smallest service age.

That promotion remains separate from this experiment.
