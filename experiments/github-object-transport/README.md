# GitHub object transport

## Question
Can a disposable worker receive exactly declared GitHub objects, no repository checkout/credential, then return only authorized byte changes for independent publication/readback?

## Claim and contrast
A manifest-bound capsule plus permission-separated hosted jobs makes input identity, writable scope, and result bytes independently checkable. The control is a normal checkout with worker credentials and path discipline by convention.

## Experiment-owned contract
`contract.mjs` owns deterministic path/request/manifest validation and is locally tested. The hosted workflow remains the integration harness because job-level permissions and GitHub object publication are part of the claim. The worker receives the contract as one of its exact declared read-only blobs, so it can validate the realized workspace without a checkout.

## Run
```sh
npm run test:github-object-transport
gh workflow run github-object-transport-proof.yml
```

## Evidence
The complete hosted path passed at exact revision `570e776aadb131589c9a47309d923e06b476e436` in run `35465653729`: materialize, no-checkout execute, trusted publish, and authoritative readback.

## Interpretation and non-claims
Workflow YAML should describe trust domains, not be the only home of experiment semantics. This is not arbitrary filesystem sandboxing or provider-native coordinate-scoped authorization.
