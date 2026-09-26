# Provider and effect extensions

A provider integration is not production-ready merely because code can call an API. Overcenter requires enough deterministic machinery to identify the effect, authorize it, reserve before mutation, observe authoritative reality, verify the exact postcondition, and recover safely from ambiguity.

## Current support matrix

| Path | Capability registered | Semantic resource registered | Trusted dispatch on `main` | Admitted production mutation profile |
| --- | --- | --- | --- | --- |
| GitHub commit status | yes | `github.commit-status` | yes | yes |
| Kubernetes ConfigMap `exists: true` | yes | `kubernetes.configmap` | yes | yes |
| GitHub pull-request update-branch | yes | no | no in the generic dispatcher | no |
| GCP Cloud Run / Cloud SQL | observation only | no | no | no |

This distinction is intentional. Registration records known semantics; it does not itself grant production authority.

## Extension pipeline

A new consequential effect should acquire these layers in order:

    semantic intent
        -> exact postcondition
        -> canonical effect coordinate
        -> adapter capabilities
        -> authoritative observation
        -> verifier
        -> trusted effect implementation
        -> kernel-minted effect authority
        -> reservation-before-mutation
        -> recovery semantics
        -> production dispatch
        -> hostile regression + hosted evidence

The important source owners are:

- [`src/semantic-effect.ts`](../src/semantic-effect.ts): compile target + desired state into an obligation;
- [`src/providers/semantic-registry.ts`](../src/providers/semantic-registry.ts): resources accepted by semantic commands;
- [`src/effect-adapter.ts`](../src/effect-adapter.ts): duplicate-delivery, replay, reservation-release, and verifier capabilities;
- [`src/semantics.ts`](../src/semantics.ts): cross-provider realization/effect identity;
- [`src/providers/effect-dispatch.ts`](../src/providers/effect-dispatch.ts): admitted trusted dispatch;
- provider-specific observation and effect files under [`src/providers/`](../src/providers/).

## Required questions

Before adding dispatch, answer all of these with executable evidence:

1. What exact external coordinate can this operation mutate?
2. Which desired states conflict, commute, or are equivalent on that coordinate?
3. Which provider observation is authoritative for presence?
4. Can absence ever be proved strongly enough to permit replay? If so, what certificate proves request terminality and non-membership?
5. What happens after timeout-after-commit, connection loss, stale readback, resource recreation, or identity drift?
6. What credential performs the effect, and why does the worker not need it?
7. Which exact authority object reaches the mutation function?
8. Can a stale generation, stale revision, or mismatched postcondition cross the boundary?

Use [`adapter-diagnosability.md`](./adapter-diagnosability.md) for information-theoretic ambiguity checks. A green diagnosability model is necessary evidence about the supplied abstraction, not proof that the provider abstraction is truthful.

## Replay is explicit

Never infer replay safety from an HTTP error, timeout, 404, or a generic `absent` flag. `src/effect-adapter.ts` makes replay and reservation release declared capabilities. An ambiguous mutation remains recovery-bound unless an admitted evidence kind proves otherwise.

## Promotion rule

Do not add a path to the generic dispatcher merely because an experiment succeeded. Promote the smallest maintained semantics demonstrated by the experiment, add ordinary regression coverage, update the production support matrix here and in the root README, and keep non-claims explicit.
