# Absence evidence certificates

## Why this exists

A boolean such as `negative_evidence_authoritative: true` collapses too much provider meaning.

The GitHub and Kubernetes observation experiments established a sharper distinction:

```text
GitHub collection non-membership
    -> usually indeterminate

Kubernetes complete consistent LIST non-membership
    -> authoritative absence at snapshot resourceVersion
```

The generic core therefore needs to carry stronger provider evidence without inventing one universal absence algorithm.

## Core envelope

Receipt v4 may carry an absence certificate with five generic fields:

```text
subject
  exact coordinate claimed absent

scope
  authority boundary actually searched

snapshot
  provider state identity, if the proof is snapshot-relative

completeness
  evidence that the searched scope was complete enough for non-membership
  to imply absence

provenance
  provider / observer / structural-certificate information needed to audit
  how the evidence was produced
```

The envelope is transport and durability structure only.

It is **not** a generic verifier.

Provider-specific code still decides whether a concrete certificate kind is sufficient to authorize replay for a concrete postcondition.

## Current concrete certificate

The local file verifier now emits:

```text
schema        overcenter-absence-evidence-v1
kind          local-file-enoent/v1
subject       exact file path
scope         direct exact-coordinate read
snapshot      null
completeness  ENOENT
provenance    node:fs / readFileSync / ENOENT
```

Settlement accepts that certificate only for `file-content-equals/v1`, and only when the certificate subject/scope match the exact postcondition path.

Eventually consistent file reads and GitHub commit-status collection misses mint no absence certificate.

## Kubernetes mapping already earned by the experiment

The ConfigMap LIST experiment can fit the same envelope:

```text
schema        overcenter-absence-evidence-v1
kind          kubernetes-complete-list-absence/v1

subject
  api_group
  resource
  namespace
  name

scope
  api_group
  resource
  namespace

snapshot
  resource_version

completeness
  initial request has no continue token
  each page request_continue == previous response_continue
  all pages share one collection resourceVersion
  intermediate pages have non-empty continuation
  terminal page has empty continuation
  no continuation expired
  page-chain digest / retained page identities

provenance
  Kubernetes provider contract identity
  structural certificate identities for every retained page
  observer identity / observation times as required
```

That certificate should be minted only by Kubernetes semantic code after the complete LIST proof exists.

The core does not yet accept this certificate kind for settlement. This is intentional. The envelope is ready; authority is not granted until a Kubernetes postcondition/verifier is integrated.

## WATCH is different

WATCH continuity should not be smuggled into a plain absence boolean.

A projection based on:

```text
complete snapshot @ R
        +
continuous WATCH from R
```

needs provenance that identifies the snapshot, watch start resourceVersion, ordered event evidence, termination, and continuity state.

If continuity breaks, absence derived from the materialized watch projection is not authoritative until relist establishes a new complete snapshot.

Whether a future Kubernetes absence certificate directly carries watch-continuity provenance or references a separately settled projection certificate should be decided when the first core Kubernetes verifier is integrated. The current envelope can represent either without forcing the choice now.

## Durable schema boundary

Receipt semantics are versioned:

```text
receipt v4
  historical execution-generation semantics
  retained for replay compatibility

receipt v5
  new writes
  absence-based replay requires a validated certificate
```

This prevents the repository from silently reinterpreting already-durable v4 facts when evidence semantics become stricter.

## Non-goals

This change does not:

- add a Kubernetes integration under `src/`;
- make arbitrary certificate payloads authoritative;
- define one generic provider consistency model;
- treat resourceVersion as numerically ordered;
- claim that a partial collection scan proves absence;
- use certificate presence as a substitute for provider-specific verification.

The intended boundary is:

```text
provider observation
      ↓
provider-specific structural / semantic validation
      ↓
absence certificate
      ↓
provider-specific certificate acceptance
      ↓
generic settlement / replay decision
```

The core carries durable proof structure. Providers own the meaning.
