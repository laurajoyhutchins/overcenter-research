# GitHub observation grammar

## Question
Can GitHub reads use a schema-derived legal observation grammar plus explicit semantic projections instead of hand-wired response assumptions?

## Claim and contrast
Pinned OpenAPI structure validates only consumed semantic slices; explicit projections then assign identity/readback meaning. The control is endpoint-specific parsing whose structural assumptions drift independently.

## Run
```sh
npm run test:github-observation
gh workflow run github-observation-grammar.yml
```

## Evidence
At `1f6ad04704b3ed594c58ad5a5759be5048c3843d`, run `35463403282` passed deterministic and pinned/live jobs.

## Interpretation and non-claims
Structural legality and provider semantic meaning are separate layers. This does not prove arbitrary GitHub API coverage or provider truthfulness.
