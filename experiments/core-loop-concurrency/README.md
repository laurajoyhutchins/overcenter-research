# Core-loop bounded concurrency

## Question

Does production `runCoreLoop({ concurrency })` recover useful parallel throughput while claims, reservations, observation, and settlement remain in one deterministic authority lane?

## Design

Run 32 independent local-file obligations through the production core loop at concurrency 1, 2, 4, and 8. Only the packet-level effect callback overlaps. Each case uses three fresh databases and artificial effect costs of 0, 25, or 100 ms.

Setup and obligation definition are excluded from timing.

## Distinguishing criterion

- At zero effect cost, extra concurrency may provide little benefit because authority work dominates.
- At material effect cost, bounded concurrency should improve throughput if the authority lane is cheap enough.
- `max_active_effects` must never exceed requested concurrency.
- All obligations must settle DONE through the production API.

## Reproduce

```sh
npm run experiment:core-loop-concurrency
```

## Result

The restacked treatment is **supported** at exact revision `11170182c7f16d216834c2453889f8ecb95adbf6`.

GitHub Actions run `35898137522`, job `107307123548`, passed all 12 cases.

| Effect cost | Concurrency 1 | Concurrency 8 | Speedup | Max active |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 67.500 tasks/s | 37.984 tasks/s | 0.563x | 1 |
| 25 ms | 22.183 tasks/s | 85.907 tasks/s | 3.873x | 8 |
| 100 ms | 8.144 tasks/s | 31.408 tasks/s | 3.857x | 8 |

The zero-cost case is the intended negative control: when packet effects are essentially free, authority work dominates and extra effect concurrency does not help. At 25 ms and 100 ms, the production path shows useful bounded overlap while never exceeding requested concurrency.

Historical pre-restack run `35571547680` remains lineage only. The table above is the current treatment evidence.

## Non-claims

- Artificial delay does not model a particular provider.
- This does not prove distributed or HA authority.
- This benchmark does not prove fairness.
- Absolute timings are host-dependent.
