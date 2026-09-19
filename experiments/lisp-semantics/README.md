# Lisp semantic-coherence experiment

## Question

Can one declarative semantic definition reduce drift among Overcenter's specialized semantic projections better than hand-wired TypeScript?

This is not an experiment in rewriting Overcenter in Lisp. It tests whether role declarations in a Lisp-shaped source can mechanically derive several related semantic views without moving execution authority or settlement into a dynamic-language runtime.

## What Overcenter already gets right

The real obligation key is not the target. src/lifecycle.ts canonical-digests the complete postcondition, packet, and consumed semantic dependencies. Adding a field to a postcondition already changes that obligation identity automatically.

The remaining fan-out lives in specialized projections. Today different code paths can independently decide:

- which fields identify an observation coordinate;
- which fields identify an effect resource;
- which value is the desired state;
- what identity is exposed to semantic downstreams;
- what scope an absence certificate proves;
- which absence evidence settlement accepts.

A new field can be present in the full postcondition and therefore safely invalidate the obligation while still being accidentally omitted from one or more of those specialized projections.

## TypeScript control

The control deliberately preserves the strong whole-postcondition behavior, then models observation coordinate, effect resource, output identity, and absence scope as independent TypeScript projections.

The hostile evolution adds an authority field. The whole-postcondition identity changes, but the old hand-wired observation, effect, and absence projections still collide across two different authorities. This is the class of drift under test.

## Candidate

verifier.lisp declares semantic roles once:

- coordinate fields feed observation identity, effect-resource identity, and absence subject/scope;
- one desired field feeds effect desired state and verification;
- one output field feeds verified-content identity;
- context fields deliberately feed none of those projections.

The tiny S-expression compiler derives canonical IR from those roles. A new coordinate field therefore updates every coordinate-dependent projection together.

## Trust boundary

No Lisp runtime, provider credential, execution permit, mutation authority, or settlement authority exists here. The experiment produces data. Existing trusted Overcenter machinery would remain the consumer and enforcer.

verifier.lisp -> tiny S-expression compiler -> canonical semantic IR -> trusted machinery

## Why Lisp-shaped first

The repository has no Lisp runtime. Adding SBCL or another implementation would mix the semantic-language question with packaging and CI concerns. This first pass tests the code-as-data/declarative property with zero runtime adoption pressure.

If this does not beat the TypeScript control, stop. If it does, a follow-up can test whether a real Lisp macro system provides another measurable benefit, such as deriving families of semantic forms with less compiler code while remaining auditable.

## Executable hostile cases

1. Whole-postcondition identity changes while stale coordinate projections still collide.
2. Adding one coordinate role updates observation, effect, and absence projections together.
3. Context-only fields do not contaminate those projections.
4. Missing or ambiguous semantic roles are rejected.
5. Missing settlement semantics and absence-policy drift are rejected.
6. Undeclared forms are rejected rather than becoming semantic escape hatches.
7. IR generation is deterministic and tampering is distinguishable.

## Success criterion

The candidate earns further investigation if a single semantic role declaration prevents projection drift that straightforward TypeScript allows, while keeping the compiler small and the kernel unchanged. Fewer lines by itself is not evidence.

## Run

node --experimental-strip-types --test experiments/lisp-semantics/lisp-semantics.test.ts
