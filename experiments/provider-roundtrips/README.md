# Provider round-trip comparison

## Question

Can Overcenter materially reduce GitHub provider latency without weakening exact repository identity, exact commit identity, status-context verification, or fail-closed behavior?

The comparison isolates two mechanical changes:

1. use Node's persistent `fetch` transport for provider reads instead of launching `curl` for each GET;
2. settle a successful commit-status mutation from GitHub's combined-status endpoint, which carries the commit SHA, repository identity, and statuses in one response.

No production code is changed by this experiment.

## Compared paths

```text
current
GET repository (curl)
POST status     (fetch)
GET repository (curl)
GET statuses    (curl)

candidate
GET repository (fetch)
POST status     (fetch)
GET combined status (fetch)
```

Each pair writes distinct status contexts against the same exact workflow SHA. Pair ordering alternates so one variant does not always receive the warmer network position.

The current path uses the production certified repository and commit-status observers. The candidate validates stable repository ID, canonical repository coordinate, exact commit SHA, status identity, normalized context, and expected state from the single combined response.

## Reproduce

Deterministic contract:

```sh
npm run test:provider-roundtrips
```

Live paired benchmark is run by `.github/workflows/provider-roundtrips.yml` with a repository-scoped workflow token.

## Success criteria

The candidate earns promotion only if:

- mismatch tests fail closed for repository ID/name, SHA, context, and state;
- every live candidate sample verifies the newly written exact status context;
- paired live measurements show a material provider-latency reduction;
- the candidate does not depend on worker-declared provider coordinates;
- no production source is modified merely to run the experiment.

## Result

See [`results/2026-09-21.md`](./results/2026-09-21.md). The candidate won all four paired live comparisons and reduced median provider time by 24.6%; combined-status readback reduced the readback median from 721 ms to 225 ms.

## Non-claims

This experiment does not establish:

- authoritative absence from one combined-status page;
- safe repository-identity caching or lease duration;
- webhook continuity;
- recovery latency after an ambiguous mutation;
- provider performance outside GitHub commit statuses.
