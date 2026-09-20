# Two-effect concurrency

## Question
Can independent READY graph branches be claimed and executed concurrently while project-authority commits remain serialized?

## Claim and contrast
Independent READY branches can be discovered and claimed by generic workers, remain EXECUTING simultaneously, settle through one serialized authority, and expose a control-join only after both complete. The contrast globally serializes graph work merely because authority updates serialize.

The deterministic proof uses the production SQLite kernel with a fork/join graph:

```text
        seed
       /    \
    left    right
       \    /
        join
```

Two fresh worker processes start together, independently call `deriveReadyWork() → claim()`, durably reserve their effects, and park behind a barrier. The proof requires the workers to hold different branch obligations simultaneously, with both branches `EXECUTING` and the join still `BLOCKED`. After both settle `DONE`, the join must become `READY`.

The existing Git-backed cases separately retain the evidence that independent effects and recovery can overlap through one CAS authority ref.

## Run
```sh
npm run test:concurrency
gh workflow run two-effect-concurrency.yml
```

## Evidence
At `1b1e7dc5b17aa6e69aad8e0958572dca1f228fac`, merge-gate run `35539239819` passed the adversarial experiment suite; the named parallel-frontier subtest passed in 562 ms. Historical hosted run `35463403309` established the narrower real-provider two-effect concurrency claim.

## Interpretation and non-claims
A positive result establishes bounded parallel graph consumption without a scheduler or worker-pool API: authority serialization does not imply work serialization. It does not establish fairness, N-way scaling, distributed/HA SQLite, or that arbitrary provider effects commute. Same-coordinate compatibility and provider-history commutativity remain separate claims.
