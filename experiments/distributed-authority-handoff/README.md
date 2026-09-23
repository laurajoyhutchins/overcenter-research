# Distributed authority handoff

## Question

Can independent disposable controllers share authoritative Overcenter project truth without a shared application database by using immutable Git facts plus one remote exact-head CAS coordinate?

This is the first bounded experiment derived from the "every agent its own database" discussion. Controller-local state may be disposable and independent. The experiment does **not** allow each controller to invent its own project authority.

## Preregistered hypothesis

For one project and one GitHub commit-status effect, a remote Git authority ref is sufficient to coordinate several controllers that share no application database:

```text
controller A local state ─┐
controller B local state ─┼─ immutable fact commits
controller C local state ─┘          │
                                     ▼
                           remote authority ref
                           exact expected-head CAS
                                     │
                                     ▼
                           authoritative project truth
```

The treatment is supported only if one exact-head claim wins, later controllers can reconstruct and continue the same run, an unresolved external effect cannot be replayed, and loss of the remote authority service fails closed even when a controller still holds a valid local copy.

## Hosted topology

The hosted workflow uses distinct GitHub Actions jobs, therefore distinct checkouts/process memory/local filesystems.

```text
setup controller
  initialize ephemeral authority ref
  define READY GitHub status obligation
        ↓
contender A          contender B
same READY revision  same READY revision
        \             /
         exact-head claim race
                ↓
          exactly one winner
                ↓ jobs end
fresh broker controller
  reconstruct winning run
  rotate execution generation
  reserve production GitHub status effect
  POST status
  terminate without settlement
                ↓
fresh recovery controller
  reconstruct unresolved reservation
  duplicate beginEffect must fail
  record interrupted execution
  fresh GitHub readback
  settle same run DONE
                ↓
fresh control controller
  stale original revision must fail
  fetch valid local authority copy
  make remote authority unreachable
  authority read must fail closed
```

The authority and contender barrier refs are unique to the workflow run and are deleted by a final cleanup job. The GitHub status context is also unique to the run.

## Local contract

```sh
npm run test:distributed-authority-handoff
```

The local contract uses separate local Git repositories over one bare remote. It covers the same kernel-level single-winner, handoff, unresolved-effect, settlement, stale-revision, and authority-unreachable invariants without GitHub credentials. A shared local file is used only as the deterministic observation fixture.

## Hosted run

The workflow is:

```text
.github/workflows/distributed-authority-handoff.yml
```

It runs automatically on a pull request that changes this experiment or its authority implementation. The hosted treatment uses the production `GitOvercenterKernel`, production remote `GitFactStore` CAS, and production GitHub commit-status effect.

## Acceptance criteria

The experiment is supported only if all of the following hold:

1. Both contenders reach a remote barrier after observing the same READY revision.
2. Exactly one claim becomes authoritative.
3. A new controller reconstructs that exact winning run after both contenders terminate.
4. Another new controller reserves and performs the GitHub status effect, then terminates before settlement.
5. A fresh recovery controller reconstructs the unresolved reservation.
6. A second effect attempt is blocked by `UNRESOLVED_EFFECT` before provider mutation.
7. Fresh provider observation settles the original run `DONE`.
8. The authority history contains exactly one claim and one effect reservation.
9. The original READY revision is rejected as stale.
10. With a valid local authority ref still present, loss of the remote authority endpoint produces `AUTHORITY_UNREACHABLE`; the local copy never silently becomes project truth.

Any violation falsifies the bounded claim.

## Interpretation boundary

A positive result would support a narrower statement than "Git is our HA database":

> Bounded multi-controller failover does not require a shared application database when durable project facts are portable and one external service supplies a linearizable authoritative-head transition.

The experiment therefore tests whether high availability can be factored into:

```text
controller-local disposable state
        +
replicated/remote immutable facts
        +
tiny exact-head authority primitive
```

rather than requiring synchronized controller databases.

## Non-claims

This experiment does not prove:

- GitHub is sufficiently available or performant for every production deployment;
- Git should replace SQLite on the normal production hot path;
- distributed authority is consensus-free;
- multi-region partition tolerance or Byzantine fault tolerance;
- every provider mutation has GitHub status observation semantics;
- local controllers may continue authoritatively while the remote authority service is unavailable;
- the experiment establishes a production HA SLA.

## Result

Supported at exact treatment revision `06cb8d5a27f92aa40e37c307d3da2f8f53c61e80` in GitHub Actions run `35924683116`.

Observed coordinates:

```text
contender A:        won
contender B:        CLAIM_LOST
run:                b4725576-69ee-440e-98ff-c72220ed482c
claim commit:       6a9fbb21e4e5fcea7c40b68d4cb081ee308d5922
broker generation:  2
reservation count:  1
post-effect head:   ac4082d8b73c3641a99ad98bcf2cd861096c8d35
recovery generation: 3
final disposition:  DONE
final authority:    90241850b7258dda7578354fed17ab89c70f48e6
stale revision:     rejected
remote unavailable: AUTHORITY_UNREACHABLE with valid local ref retained
```

The first hosted attempt found a local test-fixture bug: the fixture changed `origin` while the local kernel had been constructed with a direct bare-repository path. The fixture was corrected to use the same `remote: "origin"` indirection as the hosted treatment.

The next hosted attempt reached the live provider boundary and found a production transport defect: the fresh HTTPS GitHub status POST omitted `User-Agent`, and GitHub rejected it with HTTP 403. The production transport was repaired by adding the required header. That repair did not alter the preregistered authority behavior. The following exact-head run passed the complete treatment.
