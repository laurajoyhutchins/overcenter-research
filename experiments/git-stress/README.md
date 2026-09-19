# Git authority stress

## Question
Do Git reference-backend invariants survive adversarial Git behavior rather than only the happy path?

## Claim and contrast
The tested path fails closed under ref locks, SHA-256 repos, aggressive GC, disposable clones, and multi-process CAS. The control is single-process happy-path testing.

## Run
```sh
npm run test:stress
```

## Evidence
Passed at `1f6ad04704b3ed594c58ad5a5759be5048c3843d` in run `35463403306`.

## Interpretation and non-claims
This is safety evidence for the Git reference backend, not evidence that Git belongs on the production hot path or that arbitrary distributed filesystems behave the same.
