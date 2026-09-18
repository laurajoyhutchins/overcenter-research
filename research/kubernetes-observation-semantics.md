# Kubernetes observation semantics experiment

## Question

Can the observation / structural-certificate / fact architecture discovered with GitHub represent Kubernetes without growing a second provider semantics engine?

This experiment deliberately uses one namespace and ConfigMaps only. It is a falsification of the architecture, not the beginning of a Kubernetes integration layer.

## Provider contract established first

Kubernetes gives stronger collection and temporal guarantees than the GitHub surfaces tested so far, but only when their preconditions are kept explicit.

Relevant provider guarantees:

- resource identity is API group + resource + namespace + name; API version is a representation of the same underlying resource, not a distinct resource identity;
- `metadata.uid` distinguishes object lifetimes, including delete/recreate under the same name;
- `metadata.resourceVersion` is opaque and must not be parsed or ordered by clients;
- an unqualified LIST is a most-recent consistent read;
- paginated LIST responses connected by the server's `continue` token form one consistent snapshot, and the collection `metadata.resourceVersion` remains the snapshot boundary;
- a page that still carries a `continue` token is not a complete enumeration; the terminal response may omit the optional `continue` field, which is normalized to the empty continuation only after structural certification of that optional absence;
- an expired continuation (`410 Gone`) invalidates the consistent enumeration. A client that needs one consistent list must restart;
- WATCH from an exact known resourceVersion returns changes after that version; `410 Gone` means continuity is unavailable and the client must relist.

Primary references:

- https://kubernetes.io/docs/reference/using-api/api-concepts/
- https://kubernetes.io/docs/concepts/overview/working-with-objects/names/
- https://kubernetes.io/docs/reference/kubernetes-api/definitions/object-meta-v1-meta/

## Architecture under test

```text
Kubernetes discovery + OpenAPI V3
          ↓
RawObservation
          ↓
semantic-slice validation
          ↓
StructurallyValidatedObservation
          ↓
small Kubernetes identity / completeness rules
          ↓
Fact
          ↓
projection
```

No Kubernetes lifecycle state machine is introduced.

## First result: GET + identity

The initial ConfigMap proof retains the GitHub experiment's observation and certificate shape.

```text
GET ConfigMap
  coordinate = { api_group, resource, namespace, name }
  entity     = metadata.uid
  state      = metadata.resourceVersion
```

The requested `apiVersion / kind / namespace / name` tuple is recorded as representation evidence, but API version is not promoted into semantic identity because Kubernetes explicitly treats multiple API versions of one resource as representations of the same underlying object.

The hostile lifetime case is therefore:

```text
{ group:"", resource:"configmaps", namespace:N, name:"proof" }
  UID=A, resourceVersion=R1

DELETE

same coordinate
  UID=B, resourceVersion=Rn
```

`A != B` is a different entity lifetime even though the coordinate is unchanged.

A changed resourceVersion for the same UID is a changed state identity. The implementation intentionally does not define `R2 > R1`; resourceVersion is opaque.

## Structural validation result

The existing response-slice validator remains the validation engine. Kubernetes forced one generic extension: live Kubernetes OpenAPI V3 uses local `$ref`s, whereas the GitHub proof consumed a pinned dereferenced document.

The validator now accepts a lazy reference resolver. Path selection, primitive checking, required-field handling, array traversal, and the structural certificate are otherwise the same machinery.

This is a modest extension, not a second validation framework.

## LIST: Kubernetes earns authoritative absence

GitHub collection experiments produced this conservative rule:

```text
member not seen → INDETERMINATE
```

Kubernetes can be stronger.

For this experiment a complete ConfigMap snapshot exists only when all of the following hold:

1. the first page is an initial LIST, not a continuation;
2. each subsequent request uses exactly the previous response's `continue` token;
3. every page reports the same collection `metadata.resourceVersion`;
4. every intermediate page has a non-empty continuation token;
5. the final page has an empty continuation token;
6. no continuation failed or expired.

Only then:

```text
X ∈ snapshot@R  → authoritative membership at R
X ∉ snapshot@R  → authoritative absence at R
```

One page with a non-empty `continue` token cannot mint absence.

If a continuation expires and Kubernetes returns `410 Gone`, using the replacement token would move to a newer and therefore inconsistent snapshot. Overcenter must relist if it wants an authoritative absence claim.

## WATCH: continuity is evidence, not a side effect of receiving events

The reusable temporal shape is:

```text
complete snapshot @ R
        +
WATCH(start_resourceVersion = R)
        +
ordered certified object events
        ↓
new projection
```

Each retained event records:

- event type;
- ConfigMap coordinate;
- UID;
- object resourceVersion;
- watch start resourceVersion;
- termination condition;
- continuity state.

An ERROR / expired resourceVersion does not produce a partially trusted projection. It marks continuity as broken and requires relist.

The experiment does not compare resourceVersion strings to infer ordering. Ordering comes from the provider's watch stream rooted at the exact snapshot resourceVersion.

## Reconstruction invariant

The live proof performs:

```text
create
→ GET
→ mutate
→ GET
→ delete
→ recreate same name
→ paginated complete LIST snapshot
→ WATCH from snapshot RV
→ mutate
→ delete
→ recreate same name again
→ discard materialized projection
→ replay snapshot + watch events
→ fresh GET
→ exact projection comparison
```

The final projection compares coordinate, UID, resourceVersion, and modeled ConfigMap data.

The stale / compacted resourceVersion branch is probed live. A short-lived fresh kind cluster may not compact enough history to reproduce `410 Gone`; deterministic tests therefore require any such watch failure to produce `broken-relist-required`, and the research claim does not depend on observing compaction in every run.

## Adversarial coverage

Deterministic tests cover:

- same object, changed resourceVersion;
- same coordinate after delete/recreate, changed UID;
- resourceVersion opacity;
- one-page pagination cannot claim completeness;
- continuation token mismatch fails completeness;
- snapshot resourceVersion mismatch fails completeness;
- complete snapshot permits authoritative absence;
- snapshot + continuous watch reconstructs delete/recreate without UID collapse;
- broken watch continuity fails closed and requires relist.

The live proof adds real API discovery, OpenAPI `$ref` resolution, real GET mutation identity, real paginated LIST, real WATCH, and exact reconstruction against fresh provider readback.

## Complexity accounting

This branch is intentionally based on current `main`, while the more complete structural-certificate implementation is still isolated in draft PR #19. That means source reuse cannot yet be represented as an import without stacking the experiments.

Gross new experiment LOC at the first complete implementation:

```text
provider observation/provenance types       53
response-slice structural validator        206
Kubernetes semantic rules                  232
local adversarial tests                     125
live provider proof                         251
                                            ---
                                            867
```

Interpret the structural number carefully:

- most of `response-slice.ts` is the same validation algorithm already proven in PR #19;
- the genuinely new structural capability is lazy local `$ref` resolution plus plumbing for the resolver;
- the branch does not pretend that copied LOC vanished merely because its logic was already known.

Requested metrics:

```text
new provider-specific semantic LOC          232
new shared semantic LOC                       0
new structural-validation LOC               206 gross
  genuinely new structural concept            1  ($ref resolution)
number of genuinely new generic concepts      4
  entity lifetime
  opaque state identity
  complete collection snapshot
  temporal continuity / relist requirement
GitHub-specific assumptions deleted            0  (independent branch)
provider-specific branches in shared engine    0
```

The meaningful architectural result is marginal shape, not flattering LOC arithmetic.

## Current conclusion

So far Kubernetes supports the architecture and strengthens it.

A good provider-general boundary now appears to be:

```text
provider contract
      ↓
RawObservation
      ↓
structural certificate
      ↓
provider declarations for
  coordinate
  entity lifetime
  state identity
  collection completeness
  temporal continuity
      ↓
facts / projection
```

That taxonomy was not implemented as a generic framework. Kubernetes earned only the concrete concepts needed by the ConfigMap proof.

The important difference from GitHub is negative evidence: Kubernetes LIST can produce provider-backed authoritative absence at a named snapshot when the complete enumeration contract is satisfied. Weakening that to GitHub's always-indeterminate absence rule would throw away a real provider guarantee, so the generic architecture must allow stronger provider evidence rather than normalize every provider downward.
