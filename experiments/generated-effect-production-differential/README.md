# Generated effect production differential

## Question

Can the generated commit-status protocol replace the mechanically knowable portion of the current handwritten production adapter without changing authority, observation, mutation, recovery, or externally visible behavior, and does doing so actually reduce authored semantic surface?

This experiment is a follow-on to `generated-effect-protocol`. It does not modify production code.

## Boundary

The treatment deliberately keeps these production mechanisms unchanged:

- `KernelCore.authorizeEffect` and exact effect/verifier admission;
- certified GitHub repository identity observation;
- `KernelCore.performEffect` reservation and unresolved-effect behavior;
- provider credential handling.

Only the mechanical protocol layer changes:

```text
                  same trusted boundary
                         |
       +-----------------+-----------------+
       |                                   |
 handwritten protocol              generated protocol
 path/body/status/outcome          path/body/status/outcome
       |                                   |
       +-----------------+-----------------+
                         |
               same provider fixture
```

## Differential corpus

Both arms run through fresh production SQLite kernels. The corpus includes:

- all four GitHub commit-status states;
- HTTP 200, 201, 202, 400, 409, 422, 500, 502, and 503;
- a transport exception after reservation;
- repository identity mismatch;
- missing effect grant;
- missing token.

For every case the experiment compares provider reads, exact mutation method/path/body, whether mutation was already durably reserved when the provider call occurred, returned outcome or error text, and unresolved-effect state.

The generated arm also exposes its response classifier so the explicit classification surface is compared with the current handwritten rule: only HTTP 201 is reported success; everything else is effect-unknown.

## Marginal third adapter

A non-production `github-issue/add-comment` fixture is implemented twice:

- one handwritten pure mechanical adapter;
- one declarative protocol entry compiled by the same generator.

Both are checked by the independent checker from `generated-effect-protocol`.

Source-size comparisons use TypeScript lexical-token counts rather than formatted lines, so Biome wrapping or JSON pretty-printing does not change the result. The experiment records:

1. one-adapter introduction cost: current production commit-status adapter tokens versus candidate wrapper + shared compiler + its protocol entry;
2. third-adapter marginal cost: handwritten fixture tokens versus declarative protocol-entry tokens.

The first metric asks whether introducing the abstraction now reduces total authored mechanism. The second asks whether its incremental economics improve once the compiler already exists.

## Reproduce

This experiment is historical. Check out exact evaluated revision `9614079e875bc39c28e87b2fb85685af9eb7e50d`, install its pinned dev dependencies, then run:

```sh
npm run test:generated-effect-production-differential
```

No network or provider credential is required. The maintained head does not retain the completed experiment scaffolding.

## Interpretation

The architectural hypothesis is supported only if the behavioral differential is exact and the source metrics show an actual simplification rather than a relocation of complexity. A result where behavior agrees but total authored surface grows is a useful negative result: it means generation is mechanically viable but not yet justified as a code-reduction move.

## Non-claims

This experiment does not establish that:

- provider-specific authoritative observation can be generated;
- the synthetic third effect should become a real Overcenter effect;
- lexical token count measures cognitive complexity perfectly;
- a different generator representation cannot cross the break-even point;
- passing the differential justifies deleting handwritten production code.


## Result

The preregistered immediate-simplification claim was **falsified** at exact revision `9614079e875bc39c28e87b2fb85685af9eb7e50d`.

GitHub Actions Merge gate run `35892459282`, rerun attempt 2, candidate-evidence job `107288701401`, executed the maintained deterministic experiment suite. The generated-effect-production-differential harness reported **20/20 checks passing**:

- all 16 handwritten-versus-generated production commit-status scenarios agreed exactly;
- response classification agreed across HTTP 200, 201, 202, 400, 409, 422, 500, 502, and 503;
- the independent checker accepted both handwritten and generated forms of the synthetic third adapter.

The authored-surface result broke the simplification hypothesis:

```text
current handwritten status mechanism     236 tokens
generated first-adoption mechanism       1254 tokens
first-adoption ratio                     5.314x

handwritten third mechanical adapter      449 tokens
declarative third protocol entry          178 tokens
marginal-third ratio                     0.396x
```

So the generator is behaviorally viable and has favorable marginal economics, but it is much too expensive at the current adoption point. Overcenter should keep the handwritten production adapter rather than pay a 5.3x mechanism tax today.

Two early hosted attempts were discarded before interpretation because the metric harness expected the pre-TypeScript-7 compiler API. The accepted run used the official TypeScript 6 compatibility API for the same preregistered lexical-token metric and thresholds.

The candidate-regressions step, TLA+, and production computation-boundary proof all passed. A later self-application step failed because the self-application execution capsule did not contain the experiment-only TypeScript 6 compatibility dependency. Because the experiment was already complete and negative, the follow-up cleanup removes that dependency and executable experiment scaffolding instead of widening the production/self-application environment for a rejected abstraction.
