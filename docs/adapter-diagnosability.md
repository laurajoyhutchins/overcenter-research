# Adapter diagnosability tooling

Overcenter uses a small discrete-event-system checker as **development and CI tooling** for effect adapters.

It answers one narrow question:

> Given the protocol description supplied to the checker, can executions where an external mutation occurred remain observationally indistinguishable from executions where it did not occur?

The checker is not part of runtime authority, effect admission, recovery, or settlement.

## Run it

```sh
npm run check:adapter-diagnosability
```

The command prints a machine-readable report for each maintained analysis case and exits nonzero if a checked boundary changes or the independent depth-12 trace oracle disagrees.

The same cases are also exercised by the normal unit-test gate.

## Model

A protocol description contains:

- hidden states labeled `mutation occurred` or `mutation did not occur`;
- transitions representing provider or transport events;
- observations available to trusted recovery;
- optional consequential transitions such as `release-authority` or `settle-done`.

The analyzer builds a synchronized product of two executions with identical observation histories. A product state is ambiguous when the two executions disagree about whether the mutation occurred.

A reachable cycle containing only ambiguous product states is non-diagnosable. Separately, a consequential transition reachable while the observer is still ambiguous is reported as an unsafe witness.

An independent bounded trace enumerator provides a second implementation for the maintained finite cases. It is a checker cross-check, not an unbounded proof.

## Current GitHub status boundary

The maintained cases encode the recovery boundary established independently by the adapter uncertainty, transport, and production-path experiments:

```text
pre-secureConnect NOT_DISPATCHED
    -> safe-to-release

post-secureConnect reset
    -> ambiguous-do-not-release

HTTP 502 after dispatch
    -> ambiguous-do-not-release
```

The ambiguous cases deliberately include a candidate `release-authority` transition. That transition is a safety probe, not production behavior. The checker must produce an ambiguity witness showing why such a release would be unsafe.

## Adding or changing an adapter

1. Describe the hidden mutation worlds and the observations available to trusted recovery.
2. Mark any action whose safety depends on knowing the mutation reality as consequential.
3. Run `npm run check:adapter-diagnosability`.
4. Inspect ambiguity and unsafe-action witnesses rather than weakening the checker to obtain a desired result.
5. Establish separately that every modeled observation is trustworthy at the real provider boundary.

The last step is essential. Static diagnosability proves properties of the supplied abstraction. It cannot prove that an adapter author described the provider honestly, that an observation is authentic, or that omitted physical worlds are impossible.

## Authority boundary

Nothing under `scripts/adapter-diagnosability*.ts` may be imported by production `src/` code. A regression test enforces that separation.

A green diagnosability check means:

- the finite protocol description has the reported information structure;
- maintained boundary expectations have not silently changed;
- the bounded independent oracle agrees on the maintained cases.

It does **not** mean:

- the protocol description is a sound abstraction of an external provider;
- a separating observation is trustworthy;
- the checker may mint execution authority;
- the checker may release a reservation;
- the checker may settle `DONE`;
- a new adapter is production-admitted.

Those remain independent evidence and authority decisions.
