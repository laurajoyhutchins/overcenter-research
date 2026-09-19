# Provider observation reuse: GitHub + Kubernetes

## Question

The GitHub observation experiment established a useful architectural shape:

```text
provider contract
      ↓
RawObservation
      ↓
structural certificate
      ↓
small provider semantics
      ↓
facts
```

The Kubernetes experiment independently reproduced that shape, but its branch copied the certificate implementation. That left the important economic question unresolved:

> Does a second provider actually get cheaper when both providers are forced to share the implementation, or does a "generic" facade simply add another layer?

This stacked experiment answers that question against GitHub and Kubernetes together.

## Boundary that survived

The shared layer contains only:

```text
provider-observation/
  observation.ts
    contract identity
    observer identity
    observation time
    provider-specific request/response type parameters
    common outcome envelope

  response-slice.ts
    selected-path structural validation
    structural certificate
    optional lazy $ref resolver
```

It contains no GitHub or Kubernetes names and no provider switch.

Provider-local code still owns:

- legal operations and transport;
- selected semantic fields;
- identity meaning;
- collection completeness meaning;
- freshness / temporal meaning;
- negative-evidence strength.

That split matters. The shared code certifies structure; it does not decide what a provider response means.

## GitHub factoring

PR #19 originally placed both the reusable validator and GitHub's selected paths in:

```text
experiments/github-observation-grammar/response-slice.ts
277 LOC
```

The reuse experiment separates those concerns:

```text
experiments/provider-observation/response-slice.ts
264 LOC

experiments/github-observation-grammar/response-slices.ts
69 LOC
```

GitHub imports the shared engine directly. There is no compatibility facade and no duplicate validation implementation.

The GitHub raw observation envelope also now uses the shared provenance type while retaining its provider-specific request and response evidence, including headers, authorization class, date, ETag, Link, and request ID.

## Kubernetes factoring

The standalone Kubernetes branch required:

```text
Kubernetes observation/provenance types   53 LOC
Kubernetes response-slice validator      206 LOC
```

On the reuse branch:

```text
Kubernetes observation adapter            27 LOC
Kubernetes response-slice validator         0 LOC
```

Kubernetes supplies a resolver for its live OpenAPI V3 local `$ref`s to the same shared validator GitHub uses against its pinned dereferenced OpenAPI.

The Kubernetes semantic layer remains provider-specific. That is intentional. UID lifetime, opaque resourceVersion identity, complete LIST snapshots, continuation semantics, and WATCH continuity are provider meaning, not structural JSON validation.

## Measured marginal cost

Relative to the PR #19 GitHub baseline, sharing the observation envelope and certificate machinery adds approximately:

```text
shared observation envelope               +30
GitHub openapi observation definitions    -12
shared certificate engine move/change     -13 net
GitHub field declarations                 +69
                                           ---
shared/factoring delta                     +74 LOC
```

So the second provider's structural/provenance infrastructure is roughly:

```text
shared factoring delta                     74
Kubernetes request/operation adapter       27
                                           ---
                                           101 LOC
```

The standalone Kubernetes branch needed about 259 LOC for the corresponding observation + validator infrastructure.

This is not a claim that all future providers cost 101 LOC. It is evidence that marginal provider cost fell materially for this second provider.

Provider-specific Kubernetes semantics remain about 254 LOC. That code expresses real provider guarantees and should not be hidden inside a generic schema.

## What was *not* generalized

The experiment deliberately did not create generic abstractions for:

- entity lifetime;
- state versions;
- collection completeness;
- temporal continuity;
- authoritative negative evidence.

Those concepts are visible across providers, but two providers are not enough evidence to freeze a taxonomy into code.

Instead the shared machinery stops at certified evidence. Each provider may make stronger or weaker claims from that evidence.

This preserves the important Kubernetes result:

```text
complete consistent LIST @ R
  missing member -> authoritative ABSENT @ R
```

without weakening it to GitHub's conservative collection rule:

```text
missing member -> INDETERMINATE
```

## Falsification criteria

This factoring should be rejected if either provider requires:

- provider conditionals inside the shared certificate engine;
- weakening Kubernetes guarantees to match GitHub;
- a second structural validator;
- a shared lifecycle state machine;
- broad provider-object mirroring;
- or more generic machinery whose main consumer is the abstraction itself.

The strongest evidence is both live provider proofs executing through the same source implementation with their original semantics unchanged.

## Current interpretation

The provider-general claim is now narrower and stronger:

> Overcenter can share the mechanics that turn selected provider responses into structurally certified evidence. Provider meaning remains local.

That is a useful boundary because deterministic software owns the mechanically knowable validation step, while the provider adapter owns the small set of semantic declarations that cannot be derived from JSON structure alone.

The experiment remains under `experiments/`. Passing it does not by itself justify promotion into `src/`; that would be a separate decision based on an actual runtime consumer.
