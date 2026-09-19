# Provider observation support

This directory is shared experiment infrastructure, not an independent maintained experiment.

It contains provider-neutral response-slice/certificate machinery used by the GitHub and Kubernetes observation experiments. Focused tests cover implementation invariants such as local `$ref` traversal and fail-closed schema cycles, but no separate empirical alternative is adjudicated here.

```sh
npm run test:provider-observation
```

The registry marks this directory as `kind: support` so audits do not count reusable proof plumbing as another experiment.
