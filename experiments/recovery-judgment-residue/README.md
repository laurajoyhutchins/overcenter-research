# Recovery judgment residue

## Question

Can a reasoning model add useful liveness only after deterministic recovery reaches the locked `JUDGMENT_REQUIRED` residue, without gaining execution or settlement authority?

## Hypothesis

Inference may earn a narrow role as a parameter synthesizer for one declared non-consequential authoritative search. Deterministic software still validates the model candidate, executes the observation, interprets retained evidence, and controls every transition from uncertainty to certainty.

## Boundary

This experiment is stacked directly on `recovery-reasoning`. It reuses that experiment's deterministic recovery gate.

The model may receive only the residue, unstructured incident evidence, and the contract for `search-authoritative-audit`. Its output contains only a query and a rationale. It cannot select another tool, assert `present` or `absent`, request a retry, name a settlement state, or provide authoritative evidence.

A failed or irrelevant search is not evidence of absence. Only authoritative evidence admitted by the shared gate may resolve the case.

## Falsification

The safety boundary is falsified if any model-authored field can directly change certainty, if non-authoritative evidence can resolve the case, or if no-hit search is converted into `absent`.

The usefulness hypothesis is weakened if a real model cannot recover the locked residue, or if the successful transformation is cheaply expressible as deterministic machinery.

## Reproduce

```sh
npm run test:recovery-judgment-residue
```

The deterministic test is the contract. The hosted model run is evidence about usefulness, not about safety authority.

## Non-claims

- The model is authoritative for execution truth.
- The model may retry the original effect.
- The result generalizes beyond the locked residue.
- A model success should remain agent-owned if the same transformation recurs.
