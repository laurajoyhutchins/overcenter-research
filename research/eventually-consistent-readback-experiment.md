# Hostile Effect Experiment: Eventually Consistent Readback

## Question

What should Overcenter do when an external mutation may have succeeded, but the provider's read path can temporarily return a false negative or an older value?

This is deliberately harder than the Git ref and GitHub commit-status experiments.

Those providers give Overcenter a read path where exhausted lookup can be treated as authoritative absence. An eventually consistent provider does not.

The experiment asks:

> Can a stale negative observation accidentally turn an uncertain effect into replayable work?

## Provider model

The experiment uses a deliberately small provider simulator with two conceptual surfaces:

```text
authoritative write acceptance
          |
          | mutation succeeds
          v
provider truth

          ... replication lag ...

eventually consistent read model
```

The write can succeed before the read model exposes it.

A caller may therefore see this sequence:

```text
write accepted remotely
response lost
        |
        X
        |
read #1 -> missing
read #2 -> old value
read #3 -> expected value
```

The first two reads are intentionally hostile. They look like absence to a naive recovery loop even though the mutation already happened.

## Adapter contract

The experiment adds one intentionally narrow verifier:

```text
eventually-consistent-file-content-equals/v1
```

Its semantics are:

| observation | mutation certainty | disposition |
| --- | --- | --- |
| exact expected value | `present` | `DONE` |
| missing / ENOENT | `uncertain` | `RECOVERY_REQUIRED` |
| different value | `uncertain` | `RECOVERY_REQUIRED` |
| read failure | `uncertain` | `RECOVERY_REQUIRED` |

There is deliberately **no readback result that produces `absent`**.

This is the point of the experiment.

If the provider cannot make negative evidence authoritative, Overcenter cannot manufacture authoritative absence from a 404, stale replica, timeout, or old value.

## Executable trace

[`experiments/eventually-consistent-readback/eventually-consistent-effect.test.ts`](../experiments/eventually-consistent-readback/eventually-consistent-effect.test.ts) executes this exact trace:

```text
claim one run
    |
provider accepts effect exactly once
    |
caller loses outcome
    |
recover interrupted run
    |
readback: missing
    |
RECOVERY_REQUIRED
no READY work
same run remains authoritative
    |
readback: old value
    |
RECOVERY_REQUIRED
no READY work
same run remains authoritative
    |
readback: expected value
    |
DONE
```

The test counts provider effect attempts and asserts the count remains exactly one.

## Result

The hostile negative observations do not authorize replay.

A missing read and a stale non-matching read both settle only to `RECOVERY_REQUIRED`. The obligation remains bound to the original run, and `deriveReadyWork()` returns no replayable work.

Only positive convergence of the provider read model allows the original run to settle `DONE`.

This establishes a useful boundary:

> `READY` is not the generic opposite of `DONE`. It requires provider-specific proof of authoritative absence.

For providers that cannot supply that proof, an unresolved effect may remain `RECOVERY_REQUIRED` indefinitely.

That is a liveness cost, not a safety bug.

## Architectural consequence

The verifier contract needs to express more than “does the desired value appear?”

It also needs an answer to:

> Is a negative observation authoritative enough to permit another effect attempt?

The experiment therefore supports a three-valued recovery semantics:

```text
positive proof       -> present
authoritative negative -> absent
everything else      -> uncertain
```

Only the middle case may safely release work for replay.

## What this experiment does not prove

It does not prove:

- eventual convergence;
- bounded replication lag;
- correctness of a real cloud provider;
- that every eventually consistent API is unrecoverable;
- that compensation is impossible;
- liveness when negative evidence can never become authoritative.

The simulator is intentionally deterministic so the experiment isolates the recovery contract rather than provider timing.

A later live-provider experiment can substitute a real API with documented eventual consistency without changing the safety rule being tested.
