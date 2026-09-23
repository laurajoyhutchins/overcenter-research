# Recovery agent search

## Historical result

This preregistered one-shot inference experiment was **falsified**.

At exact evaluated revision `88c90ab73fdc49facbb48b014cd543c65d22b2a0`:

- recoverable cases: **7**;
- deterministic baseline: **4 / 7**;
- reasoning worker: **3 / 7**;
- recovery delta: **-1**;
- false certainty: **0**;
- permanent-uncertainty violations: **0**.

Hosted evidence: GitHub Actions run `35694479360`.

## Boundary

The reasoning worker received only public recovery packets and could emit search parameters or `unresolved`. It had no hidden oracle, repository checkout, provider mutation credential, execution permit, certainty authority, or settlement authority. Trusted software executed searches and required exact server-side effect binding.

The negative result is evidence against spending inference on one-shot exact-field generation for this slice. It does not imply inference has no useful role at a higher semantic boundary.

## Reproduce

Check out exact revision `88c90ab73fdc49facbb48b014cd543c65d22b2a0`, then run:

```sh
npm run test:recovery-agent-search
```

Executable/model scaffolding is historical and is not retained on current main.
