# Abstract authority-flow analysis

## Question

Can a small static abstract interpreter reject mutation paths where untrusted agent data, exact revision identity, or current execution authority cross a trust boundary incorrectly, while accepting the real GitHub mutation paths without per-path suppressions?

This experiment complements the typed-capability work. Types protect local APIs. This experiment asks whether authority facts can also be tracked after TypeScript types have been erased or weakened by serialization, queues, aliases, branch joins, and dynamic dispatch.

## Hypothesis

For Overcenter's current mutation boundary, a product abstract domain can distinguish:

- untrusted agent origin;
- candidate validation;
- exact revision identity;
- current execution/lease identity; and
- mutation-admitted control context.

The analysis should reject every preregistered hostile mutant while accepting both admitted GitHub provider mutation paths on current source.

## Abstract domain

The prototype intentionally keeps the lattice small:

```text
value facts
  untrusted-agent-origin
  candidate-validated
  exact-revision
  current-lease
  possible-call-targets

control fact
  mutation-admitted
```

Joins are conservative. If one branch is unvalidated, the joined value is unvalidated. If one branch lacks exact revision or current lease, the joined authority lacks it.

Serialization and queue boundaries deliberately erase validation and authority proof. Raw bytes may preserve data, but they do not preserve the runtime fact that those bytes were checked under a particular authority state.

## Refiners and sinks

The bounded semantic summaries are:

- `validateCandidate` establishes candidate validation while retaining untrusted provenance;
- `authorityStorePermit` establishes exact revision plus current lease;
- `performEffect` admits its callback only when both authority facts are present;
- `serialize`, `deserialize`, `enqueue`, and `dequeue` erase proof;
- `githubMutation` is consequential.

Aliases and computed dispatch are conservative: if a callable may denote `githubMutation`, it is treated as a mutation sink.

## Production check

The experiment also parses the real production source.

It accepts the provider paths only if:

1. the GitHub status POST and pull-request update PUT are lexically inside a `performEffect` callback;
2. `performEffect` calls `reserveEffect` before invoking the effect callback; and
3. `reserveEffect` still contains the current-authority, exact-revision, mutation-admission, and unresolved-effect fence.

No file-specific suppression is permitted.

## Hostile corpus

The preregistered flow mutants cover:

- raw agent output reaching mutation;
- validated candidate without mutation authority;
- mutation authority without candidate validation;
- authority serialized and reconstructed without revalidation;
- authority passed through a queue;
- candidate validation lost across serialization;
- candidate validation lost across a queue;
- aliased mutation calls;
- computed dispatch that may select the mutation sink;
- branch joins where only one path validates;
- exact revision without current lease; and
- current lease without exact revision.

Production-boundary mutants additionally cover a provider mutation escaping `performEffect`, effect invocation before the authority fence, loss of the exact-revision fence, and a post-observation conditional-fence probe where `reserveEffect` does not dominate the effect call.

Safe controls include a validated candidate, explicit revalidation after a queue, and conservative dynamic dispatch under valid authority.

## Success criteria

The hypothesis survives only if:

1. all 16 hostile mutants are rejected for their expected reason, with the post-observation dominance probe identified separately from the preregistered corpus;
2. all 4 safe controls are accepted;
3. both current production GitHub mutation paths are accepted;
4. production acceptance requires zero suppressions or per-path allowlists; and
5. the analysis runs without executing the analyzed snippets or making provider/network calls; and
6. production and self-application remain free of npm runtime dependencies.

A false positive on current production code or a false negative in the hostile corpus falsifies the current abstraction.

## Reproduce

```sh
npm run test:authority-flow-analysis
```

## Provenance

The authority-flow lattice, 12 flow mutants, 3 original production-boundary mutants, safe controls, zero-suppression production criterion, and falsification rule were preregistered. The first exact-head candidate run then exposed an orthogonal packaging error: placing the experiment in the deterministic tier caused dependency-free self-application to execute a tool that imports the TypeScript dev package. Moving the experiment to the hosted tooling tier is therefore a post-observation boundary correction, not a change to the original security corpus. A later exact-head review added one explicitly post-observation production-boundary mutant for conditional `reserveEffect` dominance after that gap was identified; it is not counted as preregistered.

## Hosted result

Supported at exact treatment revision `7554f069570e6501afc971adfb9d7420dae3b683`.

- GitHub Actions run `35920287943`, job `107382200565`: 16 / 16 hostile mutants rejected, 4 / 4 safe controls accepted, both current GitHub mutation paths accepted, and 0 production suppressions.
- Merge-gate run `35920288403`, exact-head rerun job `107384147704`: candidate certification passed for the same treatment revision.
- The TypeScript compiler API remains hosted/build-time tooling only; this result does not move the checker into production authority or dependency-free self-application.

## Interpretation

A positive result would justify a follow-on production linter that derives summaries from real modules rather than expanding this experiment into a universal TypeScript analyzer.

The important architectural claim is not that every byte can be statically trusted. It is that runtime-established authority should have a statically visible path, and proof should decay deliberately when code crosses boundaries that erase that fact.

## Non-claims

This experiment does not prove:

- soundness for arbitrary TypeScript or JavaScript;
- that runtime authority checks can be removed;
- that serialization is always unsafe, only that proof must be reconstructed after this modeled boundary;
- that every dynamic dispatch form is covered;
- that provider credentials are least-privilege;
- that malicious trusted code or explicit analyzer suppression can be prevented.
