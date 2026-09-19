# Kubernetes observation semantics

## Question
Does the observation/certificate architecture survive Kubernetes identity, complete LIST absence, and WATCH continuity rather than only GitHub semantics?

## Claim and contrast
For the ConfigMap slice, UID/resourceVersion identity, coherent pagination, authoritative absence, and continuity fit the generic certificate boundary. The contrast is assuming provider generality from GitHub alone.

## Hostile cases
Partial/mismatched page chains, resourceVersion drift, wrong namespace/name, delete/recreate UID changes, and broken WATCH continuity must fail closed.

## Run
```sh
npm run test:kubernetes-observation
gh workflow run kubernetes-observation-semantics.yml
```

The live workflow pins kind, kubectl/Kubernetes, and the node image digest.

## Interpretation and non-claims
Kubernetes is a second-provider falsifier, not an integration project for its own sake. This does not establish every Kubernetes resource or liveness.
