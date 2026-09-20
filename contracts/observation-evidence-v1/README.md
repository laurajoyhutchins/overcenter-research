# Observation and evidence contract v1

This package covers three related boundaries:

1. provider-neutral observations captured from external APIs;
2. observations persisted in current settlement receipts;
3. absence-evidence certificates used to justify safe replay.

They share provenance concerns, but they do not share authority.

## Provider observations

The provider-neutral envelope binds the provider/API operation and exact provider schema digest to an observer, time, request, response metadata, and outcome.

Provider-specific request and response semantics remain provider-owned. Any field added to the neutral outer envelope must be explicitly declared. Kubernetes currently declares one outer extension, `authority_id`, because cluster identity is part of the observation coordinate. `structural_validation` is a known derived certificate produced by schema-slice validation; recertification may replace it with a fresh certificate rather than treating it as provider data. Conditional HTTP revalidation may also add the closed `revalidated_from` provenance record binding the refreshed observation to the prior ETag-bearing observation.

## Settlement observations

Current receipt-v5 observations have a closed outer vocabulary. Verifier-specific coordinate checks still decide whether the observation applies to a particular postcondition.

The structural definition of `SettlementObservation` is projected from
[`settlement-observation.linkml.yaml`](./settlement-observation.linkml.yaml).
LinkML is authoritative only for this closed structural slice. The checked-in
JSON Schema remains the production wire artifact, and CI requires it to match
the generated projection exactly. The runtime validator remains independent.

`absence_evidence` continues to reference the separately owned absence-evidence
contract, while `provider_evidence` remains an explicit Overcenter overlay.
Provider payload meaning, evidence authority, verifier semantics, and settlement
truth are not delegated to LinkML.

CI verifies the LinkML 1.11.1 root wheel by SHA-256. Python transitive
dependencies are not yet hermetically locked, so generation is not claimed to
be a fully closed toolchain. Exact comparison against the checked-in wire
artifact makes dependency-induced projection drift fail closed.

## Absence evidence

`overcenter-absence-evidence-v1` is an envelope, not a permission slip.

A certificate becomes authoritative only when the active verifier recognizes its `kind` and proves that subject, scope, snapshot, completeness, provenance, and exact postcondition coordinate agree.

Today the accepted authoritative kinds are:

- `local-file-enoent/v1`
- `kubernetes-complete-list-absence/v1`

A new evidence kind can fit the envelope without automatically becoming accepted for replay.

## Layering

```text
provider response
      |
      v
ProviderObservation
      |
schema-derived structural certificate
      |
provider/verifier semantics
      |
SettlementObservation
      |
recognized absence matcher?
      |
      +-- no --> non-authoritative evidence
      |
      '-- yes -> exact-coordinate absence authority
```
