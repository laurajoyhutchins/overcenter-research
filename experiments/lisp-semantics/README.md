# Lisp semantic-coherence experiment

## Question

Can one declarative semantic definition make an Overcenter verifier harder to express inconsistently than the current hand-wired TypeScript style?

This is intentionally not an experiment in rewriting Overcenter in Lisp. It tests a narrower claim first: whether a Lisp-shaped semantic source plus a tiny compiler can collapse semantic fan-out without moving authority or execution into a dynamic-language runtime.

## Control

The TypeScript control mirrors the relevant current pattern: validation, semantic identity, output identity, absence acceptance, effect semantics, settlement, and verification are independent code sites.

That pattern has a real strength: new tagged verifier variants can benefit from TypeScript exhaustiveness checks. The experiment does not claim otherwise.

The hostile case is evolution within an existing verifier. Adding a new material field does not force every existing interpretation to account for it. The control adds a material compression field and demonstrates that two semantically distinct inputs remain valid while receiving the same identity.

## Candidate

verifier.lisp is the only handwritten semantic definition. The test contains a deliberately tiny S-expression reader/compiler that validates relationships among fields, identity, output, absence, effect coordinates, settlement, and verification before producing canonical IR.

The compiler rejects definitions where:

- a material field is missing from semantic identity;
- verifier version is missing from identity;
- output or verification depends on an undeclared or non-identity field;
- settlement semantics are absent;
- declared absence evidence and settlement policy disagree;
- effect coordinates reference undeclared or non-identity fields.

Context-only fields are explicitly allowed outside identity, so the candidate is not merely hashing everything.

## Trust boundary

No Lisp runtime, provider credential, execution permit, mutation authority, or settlement authority exists in this experiment. The candidate produces data. The trusted Overcenter kernel would remain the consumer and enforcer.

verifier.lisp -> tiny S-expression compiler -> canonical semantic IR -> existing trusted machinery

## Why Lisp-shaped first

The repository has no Lisp runtime. Pulling in SBCL or another implementation would mix the semantic-language question with installation, packaging, and CI concerns. This first experiment tests the code-as-data/declarative property with zero runtime adoption pressure.

If this fails to beat the TypeScript control, stop. If it succeeds, a follow-up can test whether a real Lisp macro system adds a second measurable benefit, such as deriving families of semantic forms with less compiler machinery while remaining auditable.

## Executable hostile cases

1. New material field omitted from identity.
2. Same field correctly added to identity.
3. Context-only field excluded from identity without penalty.
4. Missing settlement semantics.
5. Verifier-version identity drift.
6. Output naming an undeclared field.
7. Effect semantics naming an undeclared coordinate.
8. Absence-production versus settlement-acceptance drift.
9. Deterministic generation and detectable tampering.

## Success criterion

The candidate earns further investigation if it catches real semantic drift that the best straightforward TypeScript representation permits, while keeping one semantic source of truth and a small auditable compiler. Fewer lines by itself is not evidence.

## Run

node --experimental-strip-types --test experiments/lisp-semantics/lisp-semantics.test.ts
