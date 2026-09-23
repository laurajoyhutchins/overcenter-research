# GitHub PR update-branch uncertainty

## Question

Does the current GitHub pull-request update-branch effect preserve enough trusted information to distinguish a request that definitely never reached the provider from a request that may already have been accepted or applied when recovery later observes the old PR head?

This targets the second admitted GitHub mutation adapter. Unlike the commit-status path, update-branch currently uses ordinary `fetch` and advertises no trusted reservation-release evidence kind.

## Preregistered hypothesis

The current production adapter, durable effect reservation, and authoritative PR postcondition observation are sufficient to distinguish materially different mutation-certainty worlds that require different safe retry decisions.

The hypothesis is falsified if these two worlds require different retry decisions but reconstruct to the same durable recovery fingerprint:

1. the PUT fails before dispatch and the PR head remains the old head;
2. the PUT crosses the provider boundary, the branch update occurs or may still occur, but recovery still observes the old head.

The second world is deliberately treated as unsafe to replay. GitHub's update-branch endpoint is asynchronous and returns HTTP 202, so lack of an immediately changed head is not evidence that an already-dispatched request is terminally unable to apply.

## Treatment

The experiment runs the real production `performGithubPullRequestUpdateBranchEffect` and SQLite authority kernel while varying only an injected PUT boundary and subsequent provider visibility.

The bounded worlds vary:

- dispatch: not started or completed;
- remote effect: absent or present;
- response: transport throw, HTTP 502, or HTTP 202;
- recovery visibility: old head or updated head when an update physically occurred.

Ten reachable worlds are exercised. Every mutation attempt must first create the real durable effect reservation.

After the original worker is discarded, a fresh kernel:

1. reconstructs the unresolved reservation;
2. acquires a new execution generation;
3. attempts a duplicate adapter execution and must issue zero second PUTs;
4. records interruption recovery;
5. performs authoritative PR readback and ancestry verification;
6. settles or preserves `RECOVERY_REQUIRED`.

The durable fingerprint contains only reconstructed authority information: unresolved reservation state, whether duplicate PUT was blocked, interruption disposition, reconciliation disposition, final project status, and receipt mutation certainty/error. It excludes transient exception text and hidden physical ground truth.

## Acceptance criteria

The experiment is informative only if:

1. all ten declared worlds execute through the real production update-branch adapter and SQLite recovery path;
2. an unresolved reservation or fresh identity check prevents every second provider PUT;
3. `DONE` occurs only when the updated PR head is visible and both old-head and requested-base ancestry are established;
4. an HTTP 202 response alone never settles `DONE`;
5. observing the old head after an unresolved effect does not reopen the obligation for retry;
6. the preregistered definitely-undispatched world and dispatched-but-hidden world are compared for exact durable recovery equivalence;
7. retry-on-any-throw, retry-on-old-head-absence, and trust-HTTP-202-without-readback negative controls are all killed.

The preregistered sufficiency hypothesis is falsified if the witness pair has identical durable recovery fingerprints despite requiring different physical retry decisions.

## Reproduce

```sh
npm run test:github-pr-update-branch-uncertainty
```

No GitHub credential or external network is required. Provider mutation and visibility are injected while the production effect adapter, SQLite reservation/recovery path, PR observer, and ancestry verifier execute unchanged.

## Interpretation

A falsifying collision would be a knowledge/liveness gap, not a safety failure. The existing adapter is already conservative: replay and reservation release are forbidden, so ambiguity remains `RECOVERY_REQUIRED`.

Such a result would provide independent evidence for a diagnosability declaration saying that a generic update-branch transport failure or old-head readback is not safely diagnosable. It would **not** justify copying the commit-status `secureConnect` witness into this adapter. A future transport treatment would need its own experiment.

## Non-claims

This experiment does not establish:

- real GitHub timing or eventual-consistency distributions;
- that every HTTP 502 means the provider received the request;
- that an HTTP 202 proves the branch update eventually completed;
- that ordinary `fetch` exposes a trustworthy pre-dispatch boundary;
- safe replay or reservation release for update-branch;
- a generic rule for other GitHub or provider mutations;
- that diagnosability tooling may become runtime authority.

## Result

Pending exact-head hosted evaluation. The design, world grammar, witness pair, durable fingerprint, and negative controls are fixed before the first execution.
