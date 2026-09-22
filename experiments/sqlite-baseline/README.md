# SQLite baseline

## Question
What is the smallest local state machine that demonstrates Overcenter's original recovery and settlement invariants?

## Claim and contrast
This historical control demonstrates exact revision fencing, observation-based settlement, interrupted-run recovery, and no blind replay. The contrast is starting directly from later distributed machinery.

## Run
```sh
node --experimental-strip-types --test experiments/sqlite-baseline/kernel.test.ts
```

## Evidence
Still passes at `1f6ad04704b3ed594c58ad5a5759be5048c3843d` in run `35463403306`.

## Interpretation and non-claims
This is lineage and a regression control, not the current production authority architecture and not a distributed-coordination proof.
