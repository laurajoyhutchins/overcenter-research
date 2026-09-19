# Kubernetes semantics through the reusable core

## Question

Can the reusable Overcenter core consume Kubernetes-strength observation semantics without acquiring a Kubernetes lifecycle state machine?

This is stricter than the earlier provider-general architecture result.

The proof target is:

```text
complete Kubernetes LIST @ resourceVersion R
             │
             ▼
absence certificate
             │
             ▼
generic settlement kernel
             │
             ▼
safe replay
```

The provider adapter may understand Kubernetes identity, pagination, resourceVersion, and WATCH continuity. The generic kernel may not.

## Result being tested

A ConfigMap existence obligation is represented as:

```text
provider       kubernetes
authority_id   explicit cluster authority binding
api_group      ""
resource       configmaps
namespace      exact namespace
name           exact name
```

The cluster authority binding is material. A certificate from one cluster cannot settle an obligation against another cluster even when namespace/name/resource all match.

The Kubernetes verifier owns:

- LIST transport;
- structural validation against the Kubernetes OpenAPI schema;
- exact continuation chaining;
- one snapshot resourceVersion across every page;
- member coordinate validation;
- authoritative non-membership;
- optional carry-forward through continuous WATCH evidence.

The generic core owns only:

- postcondition identity;
- observation/certificate validation dispatch;
- accepted certificate-kind policy;
- settlement to `DONE`, `READY`, or `RECOVERY_REQUIRED`;
- durable receipt replay.

No Kubernetes pagination, WATCH, UID, resourceVersion, or relist state is stored in the kernel lifecycle.

## Authoritative absence

A complete-list absence certificate contains:

```text
subject
  provider + authority_id + group/resource/namespace/name

scope
  provider + authority_id + group/resource/namespace

snapshot
  resourceVersion

completeness
  complete-list
  page count
  terminal continuation
  digest of exact page chain

provenance
  operation identity
  authority identity
  per-page request/response continuation
  per-page resourceVersion
  structural validation paths
  schema digest
```

On replay, the certificate is not accepted by shape alone. The verifier re-derives:

1. first page started without a continuation token;
2. each later request token equals the previous response token;
3. all pages belong to the same snapshot resourceVersion;
4. all intermediate pages have a continuation token;
5. the final page terminates with an empty continuation;
6. the page count matches;
7. the stored page-chain digest recomputes exactly;
8. subject, scope, and authority match the current postcondition.

Only then may generic settlement turn authoritative absence into `READY`.

## WATCH boundary

A complete LIST proves absence at its snapshot resourceVersion.

WATCH is only needed when an adapter tries to carry that conclusion forward without relisting.

```text
complete absence @ R
       +
continuous WATCH from R
       +
target remains absent
       ↓
carried absence @ R'
```

Broken continuity, `410 Gone`, an error termination, a mismatched start resourceVersion, wrong authority/namespace, or an event making the target present all refuse carry-forward.

The kernel never sees a WATCH state machine. It receives either a certificate the provider verifier accepts or no authoritative absence.

## Hostile cases

The deterministic proof requires all of these to fail closed:

| Case | Required result |
|---|---|
| first page has a continuation but later pages are unavailable | no absence certificate |
| continuation expires / returns 410 | indeterminate, relist required |
| page resourceVersion changes mid-enumeration | no absence certificate |
| request namespace differs from obligation | no absence certificate |
| provider authority differs from obligation | no absence certificate |
| certificate subject namespace differs | cannot authorize replay |
| certificate subject name differs | cannot authorize replay |
| durable page-chain digest is altered | cannot authorize replay |
| WATCH continuity breaks | cannot carry absence forward |
| WATCH observes target present | cannot carry absence forward |

## Live proof

The hosted kind proof uses the real Kubernetes core/v1 OpenAPI document and the production response-slice validator.

It:

1. creates a namespace and one distractor ConfigMap;
2. defines an obligation that a different ConfigMap exists;
3. forces LIST pagination with `limit=1`;
4. observes complete non-membership;
5. settles the existing generic Git kernel to `READY`;
6. claims the replay;
7. crosses the existing effect-reservation boundary;
8. creates the ConfigMap on the live cluster;
9. re-observes it and settles to `DONE`;
10. constructs a fresh kernel over the same Git facts and reconstructs `DONE`.

Success therefore means more than “Kubernetes can make a certificate.” It means the existing durable settlement/replay machinery consumes Kubernetes evidence without introducing Kubernetes lifecycle state.

## Falsification criterion

This experiment fails architecturally if any of the following become necessary:

- Kubernetes-specific lifecycle statuses;
- Kubernetes-specific run or claim semantics;
- persisted pagination cursors in generic project state;
- persisted WATCH loops in the kernel;
- numeric ordering of resourceVersion;
- provider-specific settlement branches outside verifier/certificate policy;
- treating partial or stale observation as authoritative absence.

If the proof only works by adding those mechanisms, provider generality has not been established at the core implementation level.
