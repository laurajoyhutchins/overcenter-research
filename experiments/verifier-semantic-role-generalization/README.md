# Real-verifier semantic-role generalization

## Question

The synthetic semantic-coherence experiment showed that one field-role declaration can prevent several specialized projections from drifting apart.

This experiment asks the production-relevant question:

> Can a small, data-only semantic algebra reproduce the current semantics of every real Overcenter verifier without arbitrary per-verifier projector callbacks or flattening distinctions that currently matter?

No production code is changed.

## Current verifier corpus

The candidate must cover all current postconditions:

- `file-content-equals/v1`
- `eventually-consistent-file-content-equals/v1`
- `github-commit-status/v1`
- `github-commit-status/v2`
- `kubernetes-configmap-exists/v1`

## Candidate algebra

The descriptor is deliberately smaller than the current set of hand-written projections.

Field roles:

- `authority`
- `resource`
- `target`
- `desired`
- `output`
- `observation-alias`

Named canonicalizers:

- identity
- GitHub status-context canonicalization
- GitHub repository-full-name canonicalization

Capabilities:

- output identity as either value SHA-256 or subject + state;
- external effect identity from the semantic subject;
- absence evidence kind plus subject/container scope;
- local exact-coordinate versus flat provider absence binding.

Per-verifier descriptor entries are data only. They contain no callback functions.

## Why these distinctions matter

A single universal `coordinate` role is already too weak for the real code.

GitHub status v2 demonstrates two independent distinctions:

1. `repository_full_name` participates in observation binding but not effect or verified-output identity;
2. status `context` is compared literally in the observation envelope but canonicalized for semantic output and effect identity.

Kubernetes adds another:

- ConfigMap `name` belongs to the absence **subject** but not to the collection **scope** that proves absence.

The candidate therefore has to preserve these differences rather than erase them.

## Differential proof

The experiment compares descriptor-derived behavior directly with current production functions for:

- verified-content identity;
- effect resource, desired state, and commutativity;
- accepted absence-evidence kinds;
- observation-coordinate matching.

It then attacks the seams:

- GitHub context case changes must preserve semantic identity but fail raw observation binding;
- GitHub v2 repository-name case changes must remain equivalent for observation while a genuinely different name must fail;
- repository full name must not leak into effect or output identity;
- Kubernetes authority, namespace, and name changes must affect the right projections;
- changing a Kubernetes target name must change absence subject but preserve collection scope;
- local-file path must bind both absence subject and exact scope.

Provider proof completeness intentionally remains outside the role descriptor. A forged Kubernetes page-chain digest must still be rejected by the Kubernetes evidence verifier even though its semantic subject/scope binding remains unchanged.

## Failure criteria

Reject the abstraction if any current verifier requires:

- an arbitrary function-valued projector in its descriptor;
- a verifier-specific switch inside the generic projection machinery;
- collapsing observation identity into semantic identity;
- moving provider evidence-completeness logic into the generic semantic layer;
- changing current production behavior to make the descriptor fit.

## Success criterion

The abstraction earns implementation work only if the data-only descriptors differentially reproduce current behavior for the complete verifier corpus and the hostile distinctions above survive.

Even a passing result is not production adoption by itself. The next step would be a narrow refactor that replaces duplicated semantic projections with the descriptor and deletes the old branches while preserving provider-specific observation and evidence verification.

## Run

```sh
node --experimental-strip-types --test experiments/verifier-semantic-role-generalization/generalization.test.ts
```
