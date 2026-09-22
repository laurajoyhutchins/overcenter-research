# Recovery reasoning frontier

## Question

When Overcenter has deliberately entered `RECOVERY_REQUIRED` because an effect may have happened, how much liveness can deterministic software recover before inference is justified?

## Hypothesis

A reasoning agent should not receive execution or settlement authority. Deterministic software should exhaust mechanically enumerable, non-consequential recovery actions first. Inference earns a place only when useful recovery requires judgment that cannot be reduced to that typed action graph, such as synthesizing a search hypothesis over a large or unstructured evidence space.

## Experiment

This experiment has two deterministic parts.

1. It drives the production SQLite kernel through a real ambiguous-effect transition:
   claim -> reserve effect -> lose the response -> record termination -> `RECOVERY_REQUIRED`.
2. It evaluates a fixed recovery corpus through an experiment-local recovery gate:
   - every mechanically enumerable observation is safe and non-consequential;
   - only authoritative `present` or `absent` evidence can establish certainty;
   - advisory or stale observations can never manufacture certainty;
   - direct retries and bare assertions are rejected;
   - a deterministic least-cost search exhausts the typed observation graph before any judgment handoff.

The corpus deliberately includes recoverable cases, permanently unknowable cases, misleading advisory evidence, prerequisite chains, and one case whose useful search action is intentionally not mechanically enumerable.

## Falsification

The proposed inference boundary is weakened if deterministic search resolves the supposed judgment case without broadening its declared action vocabulary.

The deterministic recovery architecture is unsafe if any case:
- settles from advisory or uncertain evidence;
- settles to a state different from hidden ground truth;
- invokes a consequential effect while still uncertain;
- allows a reasoning proposal to assert `present` or `absent` directly.

The claim that inference is needed at all is weakened if future locked judgment fixtures can be solved cheaply by a deterministic planner after their tool contracts are made explicit.

## Reproduce

```sh
npm run test:recovery-reasoning
```

No network, provider credential, model credential, or hosted service is required.

## Result interpretation

This first slice does **not** prove that an LLM improves recovery. It establishes the benchmark and the safety envelope without pre-programming an agent win.

The important outputs are:

- mechanical recovery yield;
- false-certainty count;
- consequential actions attempted while uncertain;
- cases that remain permanently unresolved;
- cases that reach the explicit judgment frontier.

A later hosted stage should freeze this corpus, add genuinely parameterized/unstructured evidence-search cases, and compare the same deterministic planner with `deterministic -> agent proposal -> deterministic validation`. Model success should count only when it reduces recovery cost or recovers a locked judgment case without increasing false certainty.

## Non-claims

- The synthetic corpus is representative of every provider.
- A judgment-frontier label proves that inference is necessary.
- Agent-generated evidence is authoritative.
- An agent may retry consequential effects directly.
- `RECOVERY_REQUIRED` must eventually disappear.
