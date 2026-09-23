# GitHub status NOT_DISPATCHED reservation release

## Question

Can the admitted GitHub commit-status effect use trusted fresh-socket transport evidence to recover liveness **without** weakening the existing no-blind-replay rule?

The treatment is deliberately narrower than provider replay. GitHub commit-status replay remains forbidden. Instead, a single effect reservation may be terminated as never dispatched when the trusted transport proves the HTTP mutation never crossed the TLS application boundary.

## Preregistered hypothesis

A durable `effect-release` fact paired atomically with an `effect-not-dispatched` READY receipt can release exactly one GitHub status reservation when, and only when, the current execution authority presents an admitted `NOT_DISPATCHED` evidence kind.

The hypothesis is falsified by any of these outcomes:

- peer-observed HTTP bytes coexist with a released reservation;
- a post-`secureConnect` transport failure becomes READY;
- HTTP 502 becomes READY;
- forged evidence releases a reservation;
- stale execution authority releases a reservation;
- the old run itself is reopened for mutation instead of terminating READY;
- a retry can mutate without a new run and new effect reservation;
- GitHub status must advertise provider replay as safe to make the treatment work.

## Treatment

The real production path is exercised:

```text
ExecutionPermit
    ↓
current execution fence + authorizeEffect
    ↓
EffectAuthority
    ↓
performEffect
    ↓
private durable reservation
    ↓
fresh Node HTTPS transport
    ├─ fails before secureConnect
    │      ↓
    │   NOT_DISPATCHED
    │      ↓
    │   atomic release + READY receipt
    │      ↓
    │   new run required for retry
    │
    └─ secureConnect occurred
           ↓
        UNKNOWN on transport failure
           ↓
        reservation remains
           ↓
        RECOVERY_REQUIRED after interruption
```

The release fact is bound to the exact run, obligation, execution generation, execution-authority commit, reservation commit, effect contract, and admitted evidence kind.

The schema name is stable (`overcenter-effect-release`); its numeric version is carried separately as metadata.

## Cases

1. TLS-handshake reset before `secureConnect`: peer may see TLS bytes but zero HTTP bytes. The old attempt must become READY and a retry must use a new run.
2. TLS reset after `secureConnect`: the peer observes decrypted HTTP bytes. The reservation must remain unresolved and recovery must stay `RECOVERY_REQUIRED`.
3. HTTP 502 after receiving the request: the reservation must remain unresolved.
4. Forged evidence and stale execution authority: both must fail closed.

## Existing semantics that must remain true

- GitHub commit-status provider replay capability remains `forbidden`.
- A successful HTTP 201 still leaves the effect reserved until independent authoritative readback settles it.
- Provider identity is still derived and checked before mutation.
- Minting requires current execution authority, and the final current-head authority fence is repeated inside the private reservation step immediately before mutation.
- Unknown mutation outcomes never become automatic retries.

## Reproduce

```sh
npm run test:github-status-not-dispatched-release
```

No external GitHub mutation is required. The experiment uses the production GitHub status effect and production HTTPS transport against loopback TLS peers, with repository identity observation injected.

## Acceptance criteria

All assertions in the four cases above must pass, plus repository typechecking and the normal exact-head candidate gate.

## Non-claims

This experiment does not establish:

- provider-level idempotence or generic GitHub status replay safety;
- safe replay on reused keep-alive sockets, proxies, HTTP/2, or QUIC;
- that `secureConnect` proves GitHub received the mutation;
- automatic retry for any error after `secureConnect`;
- generic reservation release for adapters that do not explicitly admit a trusted evidence kind;
- that transport evidence can settle DONE without authoritative provider readback.

## Result

**Supported.** Exact revision `6b238e23491792dc7a8734038b82f4741a4eae8e` was evaluated in GitHub Actions
Merge gate run `35883788255`, rerun attempt 2, candidate-evidence job
`107259296679`.

The production-path treatment satisfied every preregistered case:

- **Trusted pre-dispatch release:** a TLS-handshake failure before
  `secureConnect` produced the admitted `NOT_DISPATCHED` witness. The peer
  observed 349 TLS bytes but no HTTP application bytes. The old run's
  reservation was released, its terminal receipt was `READY`, and the retry
  was a distinct new run.
- **Retry remains evidence-bound:** the new run successfully received HTTP 201,
  but its effect reservation remained unresolved until authoritative provider
  readback. Transport acknowledgement did not settle `DONE`.
- **Unknown remains fenced:** after `secureConnect`, the reset peer observed
  377 decrypted HTTP bytes. The outcome remained `RECOVERY_REQUIRED`, the
  reservation remained unresolved, and a recovery attempt issued zero mutation
  POSTs.
- **HTTP failure remains uncertain:** a 502 peer observed 97 application bytes
  and the reservation remained unresolved.
- **Authority adversaries fail closed:** a forged evidence kind and stale
  execution authority were both rejected without releasing the reservation.
- **Capability separation held:** GitHub commit-status provider replay remained
  `forbidden`; only the explicit trusted-not-dispatched reservation-release
  capability was admitted.

The same exact-head candidate passed repository typechecking, experiment
contract validation, the deterministic experiment suite, TLA+, the production
computation-boundary proof, and self-application.

Before the evaluated run, the production typechecker rejected one existing test
fixture that had not declared the new `reservation_release` capability field.
That fixture was repaired without changing the preregistered treatment or cases.
A separate standing authority-decay workflow also exposed that its historical
909-line evaluation measurement had accidentally become a permanent ceiling on
future broker features. Its runtime, authority, provider-regression, and latency
checks all remained green; the maintenance rule was corrected so the historical
SLOC result stays revision-bound evidence rather than an unrelated feature ban.

### Interpretation

The useful semantic distinction is now narrower than replay:

```text
provider replay             forbidden
reservation release         permitted only with trusted NOT_DISPATCHED evidence
unknown mutation outcome    RECOVERY_REQUIRED
successful HTTP response    still requires provider readback for DONE
```

This recovers liveness for one class of provably unexecuted attempts without
weakening the existing fail-closed rule for ambiguous effects.
