# Recovery reasoning frontier

## Historical result

This experiment established the deterministic recovery frontier before inference.

At exact evaluated revision `88b4fd815488af85280a4d8414fbdf6d6a2c6445`:

- mechanically recoverable cases: **5 / 5 resolved**;
- permanently unknowable cases: **2 / 2 remained unresolved**;
- unstructured-search residue: **1 / 1 reached JUDGMENT_REQUIRED**;
- false certainty: **0**;
- consequential recovery actions while uncertain: **0**.

Hosted evidence: GitHub Actions run `35682912211`.

## Boundary

The production SQLite kernel is driven through effect reservation, response loss, and `RECOVERY_REQUIRED`. Deterministic software may perform only declared non-consequential observations. Only authoritative present/absent evidence can change certainty or settlement.

The result does not show that inference improves recovery and does not authorize retry from uncertainty.

## Reproduce

Check out exact revision `88b4fd815488af85280a4d8414fbdf6d6a2c6445`, then run:

```sh
npm run test:recovery-reasoning
```

Executable scaffolding is historical and is not retained on current main.
