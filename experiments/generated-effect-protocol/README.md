# Generated effect protocol

## Question

Can one small declarative effect protocol generate the boring mechanics of Overcenter provider adapters while an independently implemented checker still detects generator corruption?

This is an architectural experiment, not a production migration. The current handwritten GitHub status and pull-request update-branch adapters remain authoritative while this experiment measures whether their mechanically knowable protocol facts can be authored once.

## Treatment

`effect-protocol.json` describes the two current GitHub effects using a deliberately small vocabulary:

- effect contract and postcondition verifier identity;
- required input fields and finite enums;
- HTTP method, path bindings, and request-body bindings;
- accepted response statuses;
- statuses that are proven retry-safe;
- result-class to kernel transition mapping;
- duplicate-delivery and replay capability metadata;
- deterministic returned outcome fields.

`compiler.ts` consumes that description and emits a self-contained TypeScript module with a validator, serializer, response classifier, transition function, outcome projector, and capability metadata.

`checker.ts` does not import the compiler or generated helpers. It parses the declarative contract separately, constructs its own positive and hostile inputs, derives expected requests and outcomes independently, probes the response-classification surface, and compares the generated adapter with those expectations.

```text
                 effect-protocol.json
                       /       \
                      /         \
          compiler.ts           checker.ts
              |                     |
              v                     |
      generated TypeScript          |
              |                     |
              +--------- probes ----+
                        |
                        v
                    agreement
```

The design intentionally shares the protocol description while keeping its two interpreters separate. A generator that generates its own oracle would provide correlated evidence and is not the treatment under test.

## Hostile controls

The experiment corrupts generated commit-status adapter output in eight ways:

1. accepted HTTP status changed from `201` to `200`;
2. HTTP method changed from `POST` to `PUT`;
3. path SHA binding replaced with the status context;
4. request-body context binding replaced with the commit SHA;
5. postcondition verifier identity changed;
6. unknown responses changed from `RECOVERY_REQUIRED` to `RETRY`;
7. replay capability changed from `forbidden` to `terminal-absence`;
8. the status-state validator enum is widened with an undeclared value.

Every mutant must be detected by the independent checker. The clean generated adapters for both effects must pass the same checker.

## Retry boundary

The protocol does not infer retry safety from HTTP categories. Neither current GitHub effect claims any retry-safe response status. A response that is not an explicitly accepted success therefore classifies as `effect-unknown` and transitions to `RECOVERY_REQUIRED`.

This is deliberate. The DSL cannot acquire a broad `5xx -> retry` convention by omission.

## Reproduce

This experiment is historical. Check out exact evaluated revision `834af20c303b002d1063e88fc079c192d93efd98`. It requires Node.js from `.node-version` and no network or provider credential:

```sh
npm run test:generated-effect-protocol
```

The maintained head retains the evidence and interpretation, not the completed generator/checker scaffolding.

## Success criteria

The hypothesis survives only if all of the following hold:

1. one protocol description generates validator, serializer, classifier, transitions, outcome projection, and capability metadata for both current GitHub effects;
2. the clean generated adapters agree with the independently interpreted contract;
3. all eight injected semantic corruptions are detected by the checker;
4. the checker has no source dependency on the compiler or generation function;
5. generation is deterministic;
6. retry safety remains explicit and closed: unknown responses remain `RECOVERY_REQUIRED` for both effects.

## Interpretation

A positive result would support a narrow next step: replacing duplicated, mechanically knowable adapter protocol facts with one declarative source plus generated TypeScript, while retaining an independent conformance checker.

It would not yet justify replacing provider-specific observation logic, authority admission, credential handling, or semantic interpretation with a generic adapter language.

## Non-claims

This experiment does not prove that:

- arbitrary provider APIs fit the vocabulary;
- HTTP response codes alone establish whether an external mutation occurred;
- provider-specific authoritative observation can be generated safely;
- the current handwritten production adapters should be deleted before a production differential exists;
- the checker is formally verified or implementation-independent beyond its deliberate source separation;
- a larger DSL would remain simpler than handwritten TypeScript.

## Evidence status

The harness had an exploratory local dry run while it was being shaped, so design provenance remains recorded as mixed rather than preregistered.

At exact revision `834af20c303b002d1063e88fc079c192d93efd98`, GitHub Actions Merge gate run `35888259675`, rerun attempt 2, candidate-evidence job `107274535725`, passed the deterministic experiment gate. The generated-effect-protocol harness reported **13/13 checks passing**: both clean generated adapters agreed with the separately implemented checker, all eight selected generator-output corruptions were detected, generation remained deterministic, and unknown provider responses remained `RECOVERY_REQUIRED`. The same exact-head candidate run also passed lint, typecheck, experiment-contract validation, TLA+, the production computation-boundary proof, and self-application.


The follow-on production differential later showed why the mechanism is historical rather than adopted: generated and handwritten production behavior matched, but first adoption cost 5.314x the current handwritten status mechanism. The generator therefore remains useful evidence about what can be generated safely, not an active production direction.
