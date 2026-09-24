# Proof-carrying work

## Question

Can an untrusted worker return a candidate plus a compact proof whose consumer-owned checker establishes bounded work admissibility without trusting worker assertions or re-running the worker's reasoning?

## Hypothesis

For a bounded source-work model, a small dependency-free checker can accept a valid candidate certificate, reject every hostile candidate/proof substitution, and agree with an independent trusted verifier on all cases where the underlying candidate or trusted environment changes.

The experiment deliberately does **not** ask a worker to prove that it behaved safely. Effect-boundary safety is a trusted leaf fact supplied by the consumer context. A worker assertion cannot create that fact.

## Model

The candidate is bound to an exact obligation key, run, claimed authority revision, source SHA, and execution generation. The consumer owns a policy containing writable source paths, an acceptance-policy identity, and a requirement for an independently established effect-confinement boundary.

The producer certificate is a five-node proof DAG:

```text
scope witness -------------------┐
topological graph witness -------┤
trusted acceptance fact ---------┼--> admissible
trusted effect-confinement fact -┘
```

Only the two structural rules (`scope`, `acyclic`) and two trusted-fact rules are admitted. The root must derive all four required conclusions. Trusted facts are referenced by digest but resolved only from a consumer-held map; embedding or hashing a worker assertion is insufficient.

The treatment graph checker validates a producer-supplied topological order. The independent control ignores the certificate and runs its own DFS cycle detector over the raw candidate.

## Hostile corpus

The bounded corpus contains one valid case plus 17 hostile cases covering:

- candidate-result substitution;
- run, authority revision, execution generation, and source-SHA substitution;
- policy substitution without corresponding trusted evidence;
- out-of-scope source mutation;
- acceptance evidence from another candidate;
- forged trusted-fact reference;
- omitted required premise;
- unknown worker-invented proof rule;
- cyclic graph with a fraudulent topological witness;
- graph drift after proof construction;
- duplicate proof-node identity;
- replay of an old certificate into a fresh execution generation;
- a worker-declared confinement assertion with no trusted substrate fact; and
- an ambient-provider-capability negative control with no trusted confinement fact.

Certificate-only corruptions are intentionally distinguished from semantic corruptions. The independent verifier should continue to accept a still-valid underlying candidate when only its certificate is malformed, while the proof checker must reject the malformed certificate.

## Success criteria

The hypothesis survives only if:

1. the valid candidate is accepted by both control and treatment;
2. every semantic hostile case gets the same fail-closed result from the independent control and proof checker;
3. every certificate-integrity hostile case is rejected by the proof checker even when the certificate-independent control still accepts the underlying candidate;
4. false acceptance is zero;
5. the checker remains at or below 100 nonblank function lines;
6. worker-supplied assertions cannot mint trusted acceptance or effect-confinement leaves; and
7. the ambient-authority negative control is rejected solely because the trusted effect-boundary premise is absent.

## Reproduce

```sh
npm run test:proof-carrying-work
```

No network, provider credential, model, database, proof assistant, or npm runtime dependency is required.

## Design provenance

The proof-carrying-work idea, the requirement for trusted leaf provenance, the independent-control comparison, the ambient-authority negative control, and the bounded-checker goal were specified before execution. The executable harness itself had one exploratory correction before repository preregistration: the first local run incorrectly required the independent verifier to reject a candidate when only the certificate reference was forged. Because the independent verifier intentionally ignores certificates, the harness was corrected to distinguish semantic falsifiers from certificate-integrity falsifiers without weakening either expected result. The experiment is therefore classified as **mixed provenance** rather than preregistered.

## Local exploratory result

Before repository-hosted exact-head evaluation, the corrected local harness produced:

```text
cases=18
hostile_cases=17
semantic_cases=13
semantic_control_treatment_agreement=13
certificate_integrity_cases=5
certificate_integrity_rejected=5
false_acceptance=0
checker_nonblank_lines=41
ambient_authority_negative_control_rejected=true
```

This is developmental evidence only. The registry remains pending until exact-head repository evidence runs.

## Interpretation if supported

A positive result would establish a narrow mechanism: an untrusted producer can construct a proof of bounded **admissibility**, while the consumer trusts only a compact checker plus independently sourced facts. That is materially different from asking the worker to self-attest to its own confinement or authority use.

It would justify a follow-on experiment that derives the proof policy from the production source-obligation contract and proves the tiny inference kernel against an independent semantic reference. It would not yet justify replacing production postcondition verification.

## Non-claims

This experiment does not prove:

- arbitrary software correctness;
- that a worker can prove it did not exercise ambient authority;
- that proof-carrying work replaces capability confinement or trusted observation;
- that the five-rule proof language is complete for real Overcenter obligations;
- that the checker is smaller than every task-specific verifier, only that its review surface is bounded here;
- that graph acyclicity needs proof-carrying machinery in production rather than ordinary deterministic recomputation; or
- that local exploratory success is production evidence.
