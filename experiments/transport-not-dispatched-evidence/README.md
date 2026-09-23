# Transport NOT_DISPATCHED evidence

## Question

Can a trusted HTTPS transport boundary produce a `NOT_DISPATCHED` witness that is strong enough to distinguish a definitely-not-dispatched mutation from a merely uncertain mutation outcome?

The claim is intentionally narrow. A provider mutation is considered not dispatched only when the request fails on a fresh connection **before TLS `secureConnect`**. Once the secure channel exists, any later transport error is treated as `UNKNOWN`, even if the peer eventually reports that it saw no application bytes.

## Preregistered hypothesis

For the bounded HTTPS transport model, a fresh-socket phase boundary can safely produce `NOT_DISPATCHED` for pre-`secureConnect` failures while refusing that certainty after the application transport becomes writable.

The hypothesis is falsified if any test world both:

1. produces `NOT_DISPATCHED`; and
2. allows the peer to observe decrypted HTTP request bytes.

The experiment is also falsified if post-`secureConnect` failure is incorrectly promoted to `NOT_DISPATCHED`.

## Treatment

The candidate transport uses Node's real `https.request` and tracks only whether the assigned fresh TLS socket has emitted `secureConnect`.

Four transport worlds are exercised:

1. DNS resolution failure before a connection exists;
2. TCP connection succeeds, but the peer tears down during the TLS handshake;
3. TLS completes, the peer observes decrypted HTTP request bytes, then resets before any response;
4. TLS completes and the peer returns HTTP 201 after receiving the mutation body.

The experiment uses local TCP/TLS peers so it can measure whether application bytes actually crossed the transport boundary without relying on error strings or provider state.

## Acceptance criteria

The treatment is supported only if:

- DNS failure yields `NOT_DISPATCHED`;
- TLS-handshake reset yields `NOT_DISPATCHED` and zero peer-observed application bytes;
- reset after `secureConnect` yields `UNKNOWN`;
- the peer observes application bytes in that post-connect reset case;
- HTTP 201 yields `ACKNOWLEDGED`;
- no world with peer-observed application bytes yields `NOT_DISPATCHED`;
- an error-code-only policy is killed by the post-connect reset;
- a policy that maps every transport error to `NOT_DISPATCHED` is killed.

## Reproduce

```sh
npm run test:transport-not-dispatched-evidence
```

No external network or provider credential is required. The test uses the real Node HTTPS client and local loopback peers.

## Interpretation

A positive result would establish that trustworthy negative dispatch evidence is possible at a sufficiently low transport layer, but not that the current production `fetch` wrapper exposes enough information to use it.

The architectural consequence would be small: the effect broker could adopt an instrumented HTTPS transport that returns either:

```text
ACKNOWLEDGED
NOT_DISPATCHED
UNKNOWN
```

Only `NOT_DISPATCHED` could release a reservation for automatic retry. `UNKNOWN` would preserve today's conservative `RECOVERY_REQUIRED` behavior.

## Non-claims

This experiment does not prove:

- that every Node or OS transport exposes an equally strong phase boundary;
- that an arbitrary proxy, HTTP/2 stack, QUIC stack, or connection pool preserves the same evidence;
- that a reused keep-alive socket can be classified with this fresh-socket rule;
- that TLS `secureConnect` means the provider received the later HTTP mutation;
- that a transport error after `secureConnect` proves mutation occurred;
- that production should change before the candidate transport is tested against the real GitHub effect path.

## Result

**Supported within the preregistered fresh-socket boundary.** Exact revision `0420435e83f4fd66cbeed4f3093b3c97efa78bdb` was evaluated in GitHub Actions Merge gate run `35824901839`, rerun attempt 2, candidate-evidence job `107064713901`.

Observed cases:

- DNS failure: `NOT_DISPATCHED`; no secure connection; zero peer application bytes.
- TLS-handshake reset: `NOT_DISPATCHED`; no `secureConnect`; the peer saw 349 TLS handshake bytes but zero application bytes.
- Reset after `secureConnect`: `UNKNOWN`; the peer observed 172 decrypted HTTP request bytes before reset.
- HTTP 201: `ACKNOWLEDGED`; the peer observed the complete 48-byte mutation body.

The post-handshake reset and handshake reset both produced `ECONNRESET`, so transport error code alone cannot establish dispatch certainty. Both preregistered unsafe controls were killed.

No case in which the peer observed application bytes was classified `NOT_DISPATCHED`.

This supports a narrow deterministic witness: for this Node HTTPS fresh-socket transport, failure before TLS `secureConnect` can conservatively establish that the HTTP mutation was not dispatched, while every failure after `secureConnect` remains uncertain.

The exact-head gate also passed repository type-checking, experiment-contract validation, TLA+ verification, the production computation boundary proof, and self-application.

The result does **not** justify changing production retry behavior yet. The next treatment should insert this transport contract beneath the real GitHub commit-status effect and prove that `NOT_DISPATCHED` can release exactly one reserved attempt without admitting replay for `UNKNOWN`.
