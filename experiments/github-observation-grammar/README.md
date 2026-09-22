# GitHub observation grammar

## Question
Can GitHub reads use a schema-derived legal observation grammar plus explicit semantic projections instead of hand-wired response assumptions?

## Claim and contrast
Pinned OpenAPI structure validates only the consumed semantic slices; explicit production projections then assign identity and readback meaning. The contrast is endpoint-specific parsing whose structural assumptions drift independently.

The experiment no longer carries a second GitHub parser or semantic implementation. The implementation under test is the production code in `src/providers/github/` plus the shared observation-slice machinery in `src/observation/`. The experiment is now a conformance and falsification harness around that code.

## Run
```sh
npm run test:github-observation
gh workflow run github-observation-grammar.yml
```

The deterministic harness checks representative hostile boundaries directly against production code: read-only operation registration, reserved-parameter rejection, stable repository identity across coordinate changes, exact ref and PR identity, certified projection of immutable reads, optional-field absence, non-authoritative collection misses, commit-status membership, malformed consumed fields, and refusal to treat a `304` as a fresh positive fact.

The hosted workflow independently downloads the immutable 2026-03-10 GitHub OpenAPI description, regenerates the production operation catalog, verifies the checked-in contracts against that schema, and exercises live production semantic reads plus the dedicated status, ref-fence, and PR-identity paths.

## Evidence
At `1f6ad04704b3ed594c58ad5a5759be5048c3843d`, run `35463403282` passed the original deterministic and pinned/live experiment. That historical result remains evidence for the original hypothesis. Current runs test the promoted production implementation rather than maintaining a shadow copy of it.

## Interpretation and non-claims
Structural legality and provider semantic meaning remain separate layers. Promotion into production does not make the experiment unnecessary; it changes the useful falsifier from “does this second implementation work?” to “does the production implementation still satisfy the experiment's adversarial contract?”

This does not prove arbitrary GitHub API coverage, provider truthfulness, authoritative absence from ordinary paginated reads, or that every GitHub endpoint shares one semantic projection.
